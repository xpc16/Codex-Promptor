import WebSocket from "ws";
import {
  FEDERATION_PROTOCOL_VERSION,
  FRAME_HEADER_BYTES,
  FederationClose,
  FrameType,
  MAX_FRAME_BYTES,
  RESPONSE_HEADERS,
  decodeFrame,
  decodeHeadBody,
  decodeJson,
  encodeFrame,
  encodeHeadBody,
  encodeJson,
  frameName,
  pickHeaders,
  type DirectoryDevice,
  type FederationView,
  type FrameTypeValue,
  type RequestHead,
} from "../../shared/federation-protocol.js";
import type { FederationConfig, FederationStore } from "./config.js";
import type { ExecutedResponse } from "./executor.js";
import { FederationError, LINK_HIGH_WATER_BYTES } from "./hub.js";
import { EARLY_QUEUE_BYTES, closeQuietly, relaySockets } from "./pipe.js";

/**
 * A member: a machine that keeps everything it had and adds one outbound
 * link to the hub.
 *
 * Over the link it only ever answers -- the hub opens every stream. When its
 * own page wants another machine, it does not use the link at all: it asks
 * the hub over ordinary HTTPS/WSS, which keeps the link a one-way protocol
 * and leaves connection reuse and flow control to the transport.
 *
 * Nothing is replayed after a reconnect: no request is resent, no keystroke
 * typed again, no session restarted. Pages resubscribe and read what is true
 * now, exactly as they do after any other dropped connection.
 */

export type MemberState = "connecting" | "connected" | "stopped";

export type MemberError = { code: string; message: string };

export type MemberOptions = {
  store: FederationStore;
  config: FederationConfig & { hub: NonNullable<FederationConfig["hub"]> };
  bootId: string;
  version: string;
  executeLocal: (head: RequestHead, body: Uint8Array) => Promise<ExecutedResponse>;
  openLocal: () => Promise<WebSocket>;
  onChange: () => void;
  record?: (direction: "in" | "out", kind: string, bytes: number) => void;
};

/** The hub pings every 30 s; this long without hearing anything means the link is gone even if TCP has not noticed. */
const LINK_SILENCE_MS = 75_000;
const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_AFTER_MS = 60_000;
/** A little longer than the hub's own 90 s, so its precise answer arrives first. */
const FORWARD_TIMEOUT_MS = 95_000;

type Stream = { socket: WebSocket | null; early: Array<{ data: Buffer; binary: boolean }>; earlyBytes: number; closed: boolean };

/**
 * Refusals that retrying cannot fix. Each waits for the configuration to
 * change or for someone to press retry, instead of hammering the hub.
 */
const ACCESS_DENIED: MemberError = { code: "FEDERATION_ACCESS_DENIED", message: "Cloudflare Access refused the connection. Check the service token in the join code and the Access policy." };
const FATAL_STATUS: Record<number, MemberError> = {
  302: ACCESS_DENIED,
  400: { code: "FEDERATION_LINK_INVALID", message: "The hub rejected this device's link request." },
  401: { code: "FEDERATION_TOKEN_INVALID", message: "The hub does not accept this device. It may have been removed; ask the hub for a new join code." },
  403: ACCESS_DENIED,
  409: { code: "FEDERATION_DEVICE_ID_TAKEN", message: "Another device already uses this identity. Reset this device's identity and join again." },
  426: { code: "FEDERATION_PROTOCOL_MISMATCH", message: "The hub runs a different version. Update both machines to the same release." },
};

const toBuffer = (data: WebSocket.RawData): Buffer => Buffer.isBuffer(data)
  ? data
  : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);

export class FederationMember {
  state: MemberState = "connecting";
  error: MemberError | null = null;
  private directory: DirectoryDevice[] = [];
  private socket: WebSocket | null = null;
  private failures = 0;
  private lastHeard = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly watchdog: ReturnType<typeof setInterval>;
  private readonly streams = new Map<number, Stream>();
  private stopped = false;
  private httpFailure: number | null = null;

  private constructor(private readonly options: MemberOptions) {
    this.watchdog = setInterval(() => {
      if (this.state === "connected" && Date.now() - this.lastHeard > LINK_SILENCE_MS) {
        try { this.socket?.terminate(); } catch { /* gone */ }
      }
    }, 15_000);
    this.watchdog.unref?.();
  }

  static async create(options: MemberOptions): Promise<FederationMember> {
    const member = new FederationMember(options);
    member.directory = await options.store.readDirectory();
    member.connect();
    return member;
  }

  private get hubUrl(): string { return this.options.config.hub.url; }
  private get deviceId(): string { return this.options.config.deviceId; }

  /** What every request to the hub carries: who this is, and the pass through Cloudflare Access. */
  private credentials(): Record<string, string> {
    const { token, access } = this.options.config.hub;
    return {
      authorization: `Bearer ${token}`,
      "x-promptor-device": this.deviceId,
      ...(access ? { "cf-access-client-id": access.id, "cf-access-client-secret": access.secret } : {}),
    };
  }

  private wsUrl(pathname: string): string {
    const url = new URL(pathname, this.hubUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  // ---------------------------------------------------------------- link

  private connect(): void {
    if (this.stopped) return;
    this.retryTimer = null;
    this.httpFailure = null;
    this.state = "connecting";
    const socket = new WebSocket(this.wsUrl("/federation/link"), {
      headers: {
        ...this.credentials(),
        "x-promptor-boot": this.options.bootId,
        "x-promptor-federation": String(FEDERATION_PROTOCOL_VERSION),
        "x-promptor-version": this.options.version,
      },
      maxPayload: MAX_FRAME_BYTES + FRAME_HEADER_BYTES + 1024,
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.state = "connected";
      this.error = null;
      this.lastHeard = Date.now();
      this.stableTimer = setTimeout(() => { this.failures = 0; }, STABLE_AFTER_MS);
      this.stableTimer.unref?.();
      this.options.onChange();
    });
    socket.on("ping", () => { this.lastHeard = Date.now(); });
    socket.on("message", (data, isBinary) => {
      this.lastHeard = Date.now();
      if (!isBinary) return;
      const frame = decodeFrame(toBuffer(data));
      if (frame) this.onFrame(frame.type, frame.stream, frame.payload);
    });
    socket.on("error", (error) => {
      const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
      if (status) this.httpFailure = Number(status);
    });
    socket.on("close", (code, reason) => this.onClose(socket, code, reason.toString("utf8")));
  }

  private onClose(socket: WebSocket, code: number, reason: string): void {
    if (this.socket !== socket) return;
    this.socket = null;
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    for (const stream of this.streams.values()) { stream.closed = true; closeQuietly(stream.socket, 1001, "link closed"); }
    this.streams.clear();
    if (this.stopped) return;
    if (code === FederationClose.replaced && reason !== this.options.bootId) {
      // Another process holds this identity now -- the same data folder
      // running elsewhere. Reconnecting would only push it off in turn.
      this.halt({ code: "FEDERATION_IDENTITY_CONFLICT", message: "Another copy of this device connected to the hub. If this data folder was copied, reset this device's identity and join again." });
      return;
    }
    const fatal = this.httpFailure !== null ? FATAL_STATUS[this.httpFailure] : code === 1008 ? FATAL_STATUS[401] : undefined;
    if (fatal) { this.halt(fatal); return; }
    this.state = "connecting";
    this.error = this.httpFailure !== null
      ? { code: "FEDERATION_HUB_UNREACHABLE", message: `The hub answered HTTP ${this.httpFailure}; retrying.` }
      : { code: "FEDERATION_HUB_UNREACHABLE", message: "The hub is not reachable; retrying." };
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** this.failures) * (0.7 + Math.random() * 0.6);
    this.failures = Math.min(this.failures + 1, 10);
    this.retryTimer = setTimeout(() => this.connect(), delay);
    this.retryTimer.unref?.();
    this.options.onChange();
  }

  private halt(error: MemberError): void {
    this.state = "stopped";
    this.error = error;
    this.options.onChange();
  }

  /** After the reader fixed whatever stopped the link. */
  retry(): void {
    if (this.stopped || this.socket) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.failures = 0;
    this.connect();
  }

  // ---------------------------------------------------------------- frames

  private send(type: FrameTypeValue, stream: number, payload?: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const frame = encodeFrame(type, stream, payload);
    socket.send(frame, { binary: true, compress: type !== FrameType.SocketBinary });
    this.options.record?.("out", frameName(type), frame.length);
    return true;
  }

  private onFrame(type: FrameTypeValue, stream: number, payload: Uint8Array): void {
    this.options.record?.("in", frameName(type), payload.length + FRAME_HEADER_BYTES);
    if (type === FrameType.Control) {
      const message = decodeJson<{ type?: string; devices?: DirectoryDevice[] }>(payload);
      if ((message?.type === "welcome" || message?.type === "directory") && Array.isArray(message.devices)) {
        this.directory = message.devices;
        void this.options.store.writeDirectory(message.devices).catch(() => undefined);
        this.options.onChange();
      }
      return;
    }
    if (type === FrameType.Request) { void this.answer(stream, payload); return; }
    if (type === FrameType.SocketOpen) { this.openStream(stream); return; }
    if (type === FrameType.SocketText || type === FrameType.SocketBinary) {
      const entry = this.streams.get(stream);
      if (!entry) return;
      const message = { data: Buffer.from(payload), binary: type === FrameType.SocketBinary };
      if (entry.socket) { if (entry.socket.readyState === WebSocket.OPEN) entry.socket.send(message.data, { binary: message.binary }); return; }
      entry.earlyBytes += message.data.length;
      if (entry.earlyBytes > EARLY_QUEUE_BYTES) { this.dropStream(stream, 1013, "too much before open"); return; }
      entry.early.push(message);
      return;
    }
    if (type === FrameType.SocketClose) {
      const entry = this.streams.get(stream);
      if (!entry) return;
      this.streams.delete(stream);
      entry.closed = true;
      const detail = decodeJson<{ code?: number; reason?: string }>(payload);
      closeQuietly(entry.socket, detail?.code ?? 1000, detail?.reason ?? "");
    }
  }

  private async answer(stream: number, payload: Uint8Array): Promise<void> {
    const decoded = decodeHeadBody<RequestHead>(payload);
    let response: ExecutedResponse;
    if (!decoded || typeof decoded.head.method !== "string" || typeof decoded.head.path !== "string") {
      response = this.errorResponse(400, "FEDERATION_REQUEST_INVALID", "The forwarded request could not be read.");
    } else {
      try { response = await this.options.executeLocal(decoded.head, decoded.body); }
      catch (error) { response = this.errorResponse(500, "FEDERATION_EXECUTION_FAILED", error instanceof Error ? error.message : String(error)); }
    }
    let frame = encodeHeadBody(response.head, response.body);
    if (frame.length > MAX_FRAME_BYTES) {
      const tooLarge = this.errorResponse(502, "RESPONSE_TOO_LARGE", "The response is too large to forward; it should be paged.");
      frame = encodeHeadBody(tooLarge.head, tooLarge.body);
    }
    this.send(FrameType.Response, stream, frame);
  }

  private errorResponse(status: number, code: string, message: string): ExecutedResponse {
    return {
      head: { status, headers: { "content-type": "application/json; charset=utf-8" } },
      body: Buffer.from(JSON.stringify({ error: { code, message, retryable: status >= 500 } }), "utf8"),
    };
  }

  private openStream(stream: number): void {
    const entry: Stream = { socket: null, early: [], earlyBytes: 0, closed: false };
    this.streams.set(stream, entry);
    this.options.openLocal().then((local) => {
      if (entry.closed || this.streams.get(stream) !== entry) { closeQuietly(local, 1000, "page left"); return; }
      entry.socket = local;
      for (const message of entry.early.splice(0)) local.send(message.data, { binary: message.binary });
      entry.earlyBytes = 0;
      local.on("message", (data, isBinary) => {
        if (this.streams.get(stream) !== entry) return;
        if ((this.socket?.bufferedAmount ?? 0) > LINK_HIGH_WATER_BYTES) { this.dropStream(stream, 1013, "link congested"); return; }
        this.send(isBinary ? FrameType.SocketBinary : FrameType.SocketText, stream, toBuffer(data));
      });
      local.on("close", (code, reason) => {
        if (this.streams.get(stream) !== entry) return;
        this.streams.delete(stream);
        this.send(FrameType.SocketClose, stream, encodeJson({ code, reason: reason.toString("utf8") }));
      });
      local.on("error", () => closeQuietly(local, 1011, "error"));
    }, () => {
      if (this.streams.get(stream) !== entry) return;
      this.streams.delete(stream);
      this.send(FrameType.SocketClose, stream, encodeJson({ code: 1011, reason: "could not open" }));
    });
  }

  private dropStream(stream: number, code: number, reason: string): void {
    const entry = this.streams.get(stream);
    if (!entry) return;
    this.streams.delete(stream);
    entry.closed = true;
    closeQuietly(entry.socket, code, reason);
    this.send(FrameType.SocketClose, stream, encodeJson({ code, reason }));
  }

  // ---------------------------------------------------------------- this machine's page reaching others

  /**
   * One request from this machine's page to another device, through the hub.
   *
   * Plain HTTPS, so pooling, TLS and flow control are the transport's. fetch
   * decodes gzip and brotli itself, so `content-encoding` is not passed on:
   * the bytes it returns are already plain, and over loopback their size is
   * free. The internet leg stayed compressed.
   */
  async forwardHttp(target: string, head: RequestHead, body: Uint8Array): Promise<ExecutedResponse> {
    const method = head.method.toUpperCase();
    let response: Response;
    try {
      response = await fetch(new URL(`/d/${target}${head.path}`, this.hubUrl), {
        method,
        headers: { ...pickHeaders(head.headers, ["content-type", "accept", "if-none-match"]), ...this.credentials() },
        ...(method === "GET" || !body.length ? {} : { body: new Uint8Array(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw timedOut
        ? new FederationError(504, "DEVICE_TIMEOUT", "The other device did not answer in time. The action may already have happened; check its state before repeating it.")
        : new FederationError(503, "HUB_UNREACHABLE", "The hub is not reachable from this machine.");
    }
    // Access answers a request without a valid service token with a redirect
    // to its login page. Passing that on would look like a broken API.
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      throw new FederationError(502, ACCESS_DENIED.code, ACCESS_DENIED.message);
    }
    const headers = pickHeaders(Object.fromEntries(response.headers.entries()), RESPONSE_HEADERS.filter((name) => name !== "content-encoding"));
    return { head: { status: response.status, headers }, body: Buffer.from(await response.arrayBuffer()) };
  }

  /** This machine's page's socket to another device, through the hub's `/d/<id>/ws`. */
  forwardSocket(target: string, client: WebSocket): void {
    const upstream = new WebSocket(this.wsUrl(`/d/${target}/ws`), {
      headers: this.credentials(),
      maxPayload: MAX_FRAME_BYTES,
      handshakeTimeout: 15_000,
    });
    const opened = new Promise<WebSocket>((resolve, reject) => {
      upstream.once("open", () => resolve(upstream));
      upstream.once("error", reject);
      upstream.once("close", () => reject(new Error("closed before open")));
    });
    opened.catch(() => undefined);
    relaySockets(client, opened, FederationClose.hubUnreachable, "hub unreachable");
  }

  // ---------------------------------------------------------------- view

  /**
   * The member's view of the workspace.
   *
   * While the link is down, every other device is shown as unreachable rather
   * than as it last was: an old "online" would be a claim this machine cannot
   * currently back.
   */
  view(): FederationView {
    const connected = this.state === "connected";
    const devices = this.directory.map((device) => ({
      ...device,
      online: device.id === this.deviceId ? true : connected && device.online,
    }));
    return { mode: "member", selfId: this.deviceId, hubReachable: connected, devices };
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    clearInterval(this.watchdog);
    for (const stream of this.streams.values()) { stream.closed = true; closeQuietly(stream.socket, 1001, "leaving"); }
    this.streams.clear();
    const socket = this.socket;
    this.socket = null;
    closeQuietly(socket, 1000, "leaving");
  }
}
