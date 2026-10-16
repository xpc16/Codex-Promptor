import WebSocket from "ws";
import {
  FEDERATION_PROTOCOL_VERSION,
  FederationClose,
  FrameType,
  MAX_FRAME_BYTES,
  decodeFrame,
  decodeHeadBody,
  decodeJson,
  encodeFrame,
  encodeHeadBody,
  encodeJson,
  frameName,
  isDeviceId,
  type DirectoryDevice,
  type FrameTypeValue,
  type RequestHead,
  type ResponseHead,
} from "../../shared/federation-protocol.js";
import {
  MAX_DEVICES,
  digestMatches,
  encodeJoinCode,
  newDeviceToken,
  tokenDigest,
  type DeviceEntry,
  type DeviceRegistry,
  type FederationStore,
} from "./config.js";
import type { ExecutedResponse } from "./executor.js";
import { SOCKET_HIGH_WATER_BYTES, closeQuietly } from "./pipe.js";

/**
 * The hub: the one machine the public hostname points at.
 *
 * It keeps the list of machines allowed to join, accepts their links, and
 * hands `/d/<deviceId>/…` requests to the right one. It runs its own
 * conversations exactly as before and stores nothing that belongs to anyone
 * else -- what crosses it lives in memory for as long as the request does.
 *
 * Only the hub opens streams on a link, so stream numbers are simply counted
 * up here and a member only ever answers.
 */

export class FederationError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Earlier than Cloudflare's 100 s, so the page gets this answer rather than the edge's error page. */
export const RELAY_TIMEOUT_MS = 90_000;
export const LINK_PING_MS = 30_000;
/** Above this, the link is not keeping up and the stream that wants more is dropped instead of queued. */
export const LINK_HIGH_WATER_BYTES = 8 * 1024 * 1024;
const MAX_HTTP_PER_LINK = 32;
const MAX_SOCKETS_PER_LINK = 64;

type HttpWaiter = { resolve: (response: ExecutedResponse) => void; reject: (error: FederationError) => void; timer: ReturnType<typeof setTimeout> };

type Link = {
  deviceId: string;
  bootId: string;
  version: string | null;
  socket: WebSocket;
  nextStream: number;
  http: Map<number, HttpWaiter>;
  sockets: Map<number, WebSocket>;
  alive: boolean;
};

export type LinkAuthResult =
  | { ok: true; deviceId: string; bootId: string; version: string | null }
  | { ok: false; status: number; code: string; message: string };

export type AdminDevice = {
  key: string;
  deviceId: string | null;
  name: string;
  self: boolean;
  pending: boolean;
  online: boolean;
  version: string | null;
  addedAt: string;
};

export type HubOptions = {
  store: FederationStore;
  selfId: string;
  selfName: string;
  version: string;
  publicUrl: () => string | null;
  executeLocal: (head: RequestHead, body: Uint8Array) => Promise<ExecutedResponse>;
  openLocal: () => Promise<WebSocket>;
  onChange: () => void;
  record?: (direction: "in" | "out", kind: string, bytes: number) => void;
};

const header = (headers: Record<string, unknown>, name: string): string => {
  const value = headers[name];
  return typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
};

const bearer = (headers: Record<string, unknown>): string => {
  const value = header(headers, "authorization");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
};

const toBuffer = (data: WebSocket.RawData): Buffer => Buffer.isBuffer(data)
  ? data
  : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);

export class FederationHub {
  private registry: DeviceRegistry = { schemaVersion: 1, devices: [] };
  private readonly links = new Map<string, Link>();
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private closed = false;

  private constructor(private readonly options: HubOptions) {
    this.pingTimer = setInterval(() => this.pingLinks(), LINK_PING_MS);
    this.pingTimer.unref?.();
  }

  static async create(options: HubOptions): Promise<FederationHub> {
    const hub = new FederationHub(options);
    await hub.load();
    return hub;
  }

  /** The hub is always the first entry, so it is listed first everywhere. */
  private async load(): Promise<void> {
    const stored = await this.options.store.readRegistry();
    const others = stored.devices.filter((entry) => entry.deviceId !== this.options.selfId);
    const existingSelf = stored.devices.find((entry) => entry.deviceId === this.options.selfId);
    const self: DeviceEntry = {
      deviceId: this.options.selfId,
      name: existingSelf?.name ?? this.options.selfName,
      tokenSha256: null,
      addedAt: existingSelf?.addedAt ?? new Date().toISOString(),
    };
    this.registry = { schemaVersion: 1, devices: [self, ...others] };
    await this.options.store.writeRegistry(this.registry);
  }

  // ---------------------------------------------------------------- joining

  /**
   * Decides whether a link may be opened, before anything is upgraded.
   *
   * The token binds to the first device id that presents it, so a join code
   * cannot be used by two machines. Async only because that binding is saved.
   */
  async authenticate(headers: Record<string, unknown>): Promise<LinkAuthResult> {
    const protocol = Number(header(headers, "x-promptor-federation"));
    if (protocol !== FEDERATION_PROTOCOL_VERSION) {
      return { ok: false, status: 426, code: "FEDERATION_PROTOCOL_MISMATCH", message: "This device speaks a different federation protocol version; update both to the same release." };
    }
    const token = bearer(headers);
    const deviceId = header(headers, "x-promptor-device");
    const bootId = header(headers, "x-promptor-boot");
    const version = header(headers, "x-promptor-version").slice(0, 80) || null;
    if (!token || !isDeviceId(deviceId) || !/^[A-Za-z0-9_-]{8,64}$/.test(bootId)) {
      return { ok: false, status: 400, code: "FEDERATION_LINK_INVALID", message: "The link request is missing its device credentials." };
    }
    const entry = this.registry.devices.find((candidate) => digestMatches(token, candidate.tokenSha256));
    if (!entry) return { ok: false, status: 401, code: "FEDERATION_TOKEN_INVALID", message: "This device is not on the hub's list. Ask the hub for a new join code." };
    if (entry.deviceId && entry.deviceId !== deviceId) {
      return { ok: false, status: 401, code: "FEDERATION_TOKEN_BOUND", message: "This join code already belongs to another device." };
    }
    if (!entry.deviceId) {
      if (this.registry.devices.some((candidate) => candidate.deviceId === deviceId)) {
        return { ok: false, status: 409, code: "FEDERATION_DEVICE_ID_TAKEN", message: "Another entry already uses this device id. Reset the device identity and join again." };
      }
      entry.deviceId = deviceId;
      await this.options.store.writeRegistry(this.registry);
    }
    return { ok: true, deviceId, bootId, version };
  }

  /** The device behind a `/d/…` request a member made for its own page, or null. */
  verifyDeviceRequest(headers: Record<string, unknown>): string | null {
    const token = bearer(headers);
    const deviceId = header(headers, "x-promptor-device");
    if (!token || !isDeviceId(deviceId)) return null;
    const entry = this.registry.devices.find((candidate) => candidate.deviceId === deviceId);
    return entry && digestMatches(token, entry.tokenSha256) ? deviceId : null;
  }

  /**
   * Takes over an authenticated link.
   *
   * The newest connection for a device wins. The same process reconnecting
   * just replaces its old link; a different process -- the same data folder
   * running on two machines -- displaces the old one with 4409, and the old
   * one stops instead of fighting back.
   */
  attach(socket: WebSocket, auth: Extract<LinkAuthResult, { ok: true }>): void {
    if (this.closed) { closeQuietly(socket, 1001, "hub stopping"); return; }
    const previous = this.links.get(auth.deviceId);
    const link: Link = {
      deviceId: auth.deviceId,
      bootId: auth.bootId,
      version: auth.version,
      socket,
      nextStream: 1,
      http: new Map(),
      sockets: new Map(),
      alive: true,
    };
    this.links.set(auth.deviceId, link);
    if (previous) {
      closeQuietly(previous.socket, previous.bootId === auth.bootId ? FederationClose.superseded : FederationClose.replaced, auth.bootId);
    }
    socket.on("pong", () => { link.alive = true; });
    socket.on("message", (data, isBinary) => {
      link.alive = true;
      if (!isBinary) return;
      const frame = decodeFrame(toBuffer(data));
      if (frame) this.onFrame(link, frame.type, frame.stream, frame.payload);
    });
    socket.on("close", () => this.detach(link));
    socket.on("error", () => { try { socket.terminate(); } catch { /* gone */ } });
    this.send(link, FrameType.Control, 0, encodeJson({ type: "welcome", deviceId: auth.deviceId, devices: this.directory() }));
    this.changed();
  }

  private detach(link: Link): void {
    for (const waiter of link.http.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new FederationError(503, "DEVICE_OFFLINE", "The device went offline before it answered. The action may or may not have happened; check after it reconnects."));
    }
    link.http.clear();
    for (const client of link.sockets.values()) closeQuietly(client, FederationClose.deviceUnavailable, "device offline");
    link.sockets.clear();
    if (this.links.get(link.deviceId) === link) {
      this.links.delete(link.deviceId);
      this.changed();
    }
  }

  private pingLinks(): void {
    for (const link of this.links.values()) {
      if (!link.alive) { try { link.socket.terminate(); } catch { /* gone */ } continue; }
      link.alive = false;
      try { link.socket.ping(); } catch { /* closing */ }
    }
  }

  // ---------------------------------------------------------------- frames

  private send(link: Link, type: FrameTypeValue, stream: number, payload?: Uint8Array): boolean {
    if (link.socket.readyState !== WebSocket.OPEN) return false;
    const frame = encodeFrame(type, stream, payload);
    // A binary socket frame is ciphertext -- deflate would only spend CPU on it.
    link.socket.send(frame, { binary: true, compress: type !== FrameType.SocketBinary });
    this.options.record?.("out", frameName(type), frame.length);
    return true;
  }

  private nextStream(link: Link): number {
    const stream = link.nextStream;
    link.nextStream = link.nextStream >= 0xfffffffe ? 1 : link.nextStream + 1;
    return stream;
  }

  private onFrame(link: Link, type: FrameTypeValue, stream: number, payload: Uint8Array): void {
    this.options.record?.("in", frameName(type), payload.length + 5);
    if (type === FrameType.Response) {
      const waiter = link.http.get(stream);
      if (!waiter) return;
      link.http.delete(stream);
      clearTimeout(waiter.timer);
      const decoded = decodeHeadBody<ResponseHead>(payload);
      if (!decoded || typeof decoded.head.status !== "number") {
        waiter.reject(new FederationError(502, "DEVICE_BAD_RESPONSE", "The device sent a response this hub could not read."));
        return;
      }
      waiter.resolve({ head: { status: decoded.head.status, headers: decoded.head.headers ?? {} }, body: Buffer.from(decoded.body) });
      return;
    }
    if (type === FrameType.SocketText || type === FrameType.SocketBinary) {
      const client = link.sockets.get(stream);
      if (!client || client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > SOCKET_HIGH_WATER_BYTES) {
        link.sockets.delete(stream);
        closeQuietly(client, 1013, "slow consumer");
        this.send(link, FrameType.SocketClose, stream, encodeJson({ code: 1013, reason: "slow consumer" }));
        return;
      }
      client.send(Buffer.from(payload), { binary: type === FrameType.SocketBinary });
      return;
    }
    if (type === FrameType.SocketClose) {
      const client = link.sockets.get(stream);
      if (!client) return;
      link.sockets.delete(stream);
      const detail = decodeJson<{ code?: number; reason?: string }>(payload);
      closeQuietly(client, detail?.code ?? 1000, detail?.reason ?? "");
    }
  }

  // ---------------------------------------------------------------- routing

  isOnline(deviceId: string): boolean {
    return deviceId === this.options.selfId || this.links.has(deviceId);
  }

  isRegistered(deviceId: string): boolean {
    return this.registry.devices.some((entry) => entry.deviceId === deviceId);
  }

  /** One HTTP request to a device, answered or failed within RELAY_TIMEOUT_MS. */
  request(deviceId: string, head: RequestHead, body: Uint8Array): Promise<ExecutedResponse> {
    if (deviceId === this.options.selfId) return this.options.executeLocal(head, body);
    const link = this.links.get(deviceId);
    if (!link) {
      return Promise.reject(this.isRegistered(deviceId)
        ? new FederationError(503, "DEVICE_OFFLINE", "That device is offline.")
        : new FederationError(404, "DEVICE_UNKNOWN", "There is no such device in this workspace."));
    }
    if (link.http.size >= MAX_HTTP_PER_LINK) return Promise.reject(new FederationError(503, "DEVICE_BUSY", "That device has too many requests in flight; try again shortly."));
    const frame = encodeHeadBody(head, body);
    if (frame.length > MAX_FRAME_BYTES) return Promise.reject(new FederationError(413, "REQUEST_TOO_LARGE", "The request is too large to forward."));
    const stream = this.nextStream(link);
    return new Promise<ExecutedResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        link.http.delete(stream);
        reject(new FederationError(504, "DEVICE_TIMEOUT", "The device did not answer in time. The action may already have happened; check its state before repeating it."));
      }, RELAY_TIMEOUT_MS);
      timer.unref?.();
      link.http.set(stream, { resolve, reject, timer });
      if (!this.send(link, FrameType.Request, stream, frame)) {
        link.http.delete(stream);
        clearTimeout(timer);
        reject(new FederationError(503, "DEVICE_OFFLINE", "That device is offline."));
      }
    });
  }

  /** Carries a page's socket to a member's `/ws` over its link. The hub's own conversations never come here. */
  connect(deviceId: string, client: WebSocket): void {
    const link = this.links.get(deviceId);
    if (!link) { closeQuietly(client, FederationClose.deviceUnavailable, "device offline"); return; }
    if (link.sockets.size >= MAX_SOCKETS_PER_LINK) { closeQuietly(client, 1013, "device busy"); return; }
    const stream = this.nextStream(link);
    link.sockets.set(stream, client);
    client.on("message", (data, isBinary) => {
      if (link.sockets.get(stream) !== client) return;
      if (link.socket.bufferedAmount > LINK_HIGH_WATER_BYTES) {
        link.sockets.delete(stream);
        closeQuietly(client, 1013, "link congested");
        this.send(link, FrameType.SocketClose, stream, encodeJson({ code: 1013, reason: "link congested" }));
        return;
      }
      this.send(link, isBinary ? FrameType.SocketBinary : FrameType.SocketText, stream, toBuffer(data));
    });
    client.on("close", (code, reason) => {
      if (link.sockets.get(stream) !== client) return;
      link.sockets.delete(stream);
      this.send(link, FrameType.SocketClose, stream, encodeJson({ code, reason: reason.toString("utf8") }));
    });
    client.on("error", () => closeQuietly(client, 1011, "error"));
    this.send(link, FrameType.SocketOpen, stream, encodeJson({}));
  }

  // ---------------------------------------------------------------- directory

  /** Registration order, the hub first; pending entries have no id yet and are not listed. */
  directory(): DirectoryDevice[] {
    return this.registry.devices
      .filter((entry): entry is DeviceEntry & { deviceId: string } => Boolean(entry.deviceId))
      .map((entry) => ({
        id: entry.deviceId,
        name: entry.name,
        online: this.isOnline(entry.deviceId),
        version: entry.deviceId === this.options.selfId ? this.options.version : this.links.get(entry.deviceId)?.version ?? null,
      }));
  }

  private changed(): void {
    if (this.closed) return;
    const devices = this.directory();
    for (const link of this.links.values()) this.send(link, FrameType.Control, 0, encodeJson({ type: "directory", devices }));
    this.options.onChange();
  }

  // ---------------------------------------------------------------- admin

  entries(): AdminDevice[] {
    return this.registry.devices.map((entry, index) => ({
      key: entry.deviceId ?? `pending-${index}`,
      deviceId: entry.deviceId,
      name: entry.name,
      self: entry.deviceId === this.options.selfId,
      pending: !entry.deviceId,
      online: entry.deviceId ? this.isOnline(entry.deviceId) : false,
      version: entry.deviceId === this.options.selfId ? this.options.version : entry.deviceId ? this.links.get(entry.deviceId)?.version ?? null : null,
      addedAt: entry.addedAt,
    }));
  }

  private entryIndex(key: string): number {
    return this.registry.devices.findIndex((entry, index) => (entry.deviceId ?? `pending-${index}`) === key);
  }

  /** A new entry and the one-time join code for it. The hub keeps only the token's digest. */
  async addDevice(name: string, access: { id: string; secret: string } | null): Promise<string> {
    const publicUrl = this.options.publicUrl();
    if (!publicUrl) throw new FederationError(400, "FEDERATION_PUBLIC_URL_MISSING", "Set the hub's public address first.");
    if (this.registry.devices.length >= MAX_DEVICES) throw new FederationError(400, "FEDERATION_TOO_MANY_DEVICES", `At most ${MAX_DEVICES} devices can be registered.`);
    const token = newDeviceToken();
    this.registry.devices.push({ deviceId: null, name, tokenSha256: tokenDigest(token), addedAt: new Date().toISOString() });
    await this.options.store.writeRegistry(this.registry);
    this.options.onChange();
    return encodeJoinCode({ hub: publicUrl, token, access });
  }

  async renameDevice(key: string, name: string): Promise<void> {
    const index = this.entryIndex(key);
    if (index < 0) throw new FederationError(404, "DEVICE_UNKNOWN", "There is no such device.");
    this.registry.devices[index]!.name = name;
    await this.options.store.writeRegistry(this.registry);
    this.changed();
  }

  /**
   * Off the list, and off the link. Its conversations stay where they are; a
   * task it is running keeps running. Deleting its Cloudflare service token
   * is the other half (docs §8.3).
   */
  async removeDevice(key: string): Promise<void> {
    const index = this.entryIndex(key);
    if (index < 0) throw new FederationError(404, "DEVICE_UNKNOWN", "There is no such device.");
    const entry = this.registry.devices[index]!;
    if (entry.deviceId === this.options.selfId) throw new FederationError(400, "FEDERATION_CANNOT_REMOVE_HUB", "The hub cannot remove itself; turn federation off instead.");
    this.registry.devices.splice(index, 1);
    await this.options.store.writeRegistry(this.registry);
    const link = entry.deviceId ? this.links.get(entry.deviceId) : undefined;
    if (link) closeQuietly(link.socket, 1008, "removed");
    this.changed();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    for (const link of [...this.links.values()]) {
      closeQuietly(link.socket, 1001, "hub stopping");
      this.detach(link);
    }
    this.links.clear();
  }
}
