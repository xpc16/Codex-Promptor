import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type WebSocket from "ws";
import {
  FEDERATION_OFF_VIEW,
  FederationClose,
  type FederationMode,
  type FederationView,
  type RequestHead,
} from "../../shared/federation-protocol.js";
import {
  FederationStore,
  decodeJoinCode,
  defaultDeviceName,
  normalizeHubUrl,
  type FederationConfig,
} from "./config.js";
import type { ExecutedResponse } from "./executor.js";
import { FederationError, FederationHub, type AdminDevice, type LinkAuthResult } from "./hub.js";
import { FederationMember, type MemberError, type MemberState } from "./member.js";
import { closeQuietly, relaySockets } from "./pipe.js";

/**
 * The one object the app talks to about federation, whatever role this
 * machine has. It owns the configuration, starts the hub or the member, and
 * routes a `/d/<deviceId>/…` request to wherever that device can be reached.
 */

export type FederationServiceOptions = {
  dataDir: string;
  version: string;
  executeLocal: (head: RequestHead, body: Uint8Array) => Promise<ExecutedResponse>;
  openLocal: () => Promise<WebSocket>;
  record?: (direction: "in" | "out", kind: string, bytes: number) => void;
};

export type FederationAdminView = {
  mode: FederationMode;
  deviceId: string;
  name: string;
  publicUrl: string | null;
  hubUrl: string | null;
  link: { state: MemberState | null; error: MemberError | null };
  devices: AdminDevice[];
};

const NAME_LIMIT = 80;
export function cleanName(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (text || fallback).slice(0, NAME_LIMIT);
}

export class FederationService extends EventEmitter {
  private config!: FederationConfig;
  private hub: FederationHub | null = null;
  private member: FederationMember | null = null;
  private readonly store: FederationStore;
  /** Per process, never stored: tells a reconnect of this process from another copy of this device. */
  readonly bootId = randomBytes(12).toString("base64url");
  private started = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly options: FederationServiceOptions) {
    super();
    this.store = new FederationStore(options.dataDir);
  }

  static async create(options: FederationServiceOptions): Promise<FederationService> {
    const service = new FederationService(options);
    service.config = await service.store.readConfig();
    return service;
  }

  /** Mode changes go one at a time; two clicks must not start two hubs. */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  mode(): FederationMode { return this.config.mode; }

  /** This machine's id while federation is on; null when off. */
  selfId(): string | null { return this.config.mode === "off" ? null : this.config.deviceId; }

  /** Called once the app can serve injected requests, which the roles need. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.serial(() => this.startRole());
  }

  private async startRole(): Promise<void> {
    this.stopRole();
    const changed = () => this.emit("changed");
    if (this.config.mode === "hub") {
      this.hub = await FederationHub.create({
        store: this.store,
        selfId: this.config.deviceId,
        selfName: this.config.name,
        version: this.options.version,
        publicUrl: () => this.config.publicUrl,
        executeLocal: this.options.executeLocal,
        openLocal: this.options.openLocal,
        onChange: changed,
        record: this.options.record,
      });
    } else if (this.config.mode === "member" && this.config.hub) {
      this.member = await FederationMember.create({
        store: this.store,
        config: this.config as FederationConfig & { hub: NonNullable<FederationConfig["hub"]> },
        bootId: this.bootId,
        version: this.options.version,
        executeLocal: this.options.executeLocal,
        openLocal: this.options.openLocal,
        onChange: changed,
        record: this.options.record,
      });
    }
    changed();
  }

  private stopRole(): void {
    this.hub?.close();
    this.hub = null;
    this.member?.stop();
    this.member = null;
  }

  // ---------------------------------------------------------------- pages

  view(): FederationView {
    if (this.hub) return { mode: "hub", selfId: this.config.deviceId, hubReachable: true, devices: this.hub.directory() };
    if (this.member) return this.member.view();
    return FEDERATION_OFF_VIEW;
  }

  // ---------------------------------------------------------------- routing

  async authenticateLink(headers: Record<string, unknown>): Promise<LinkAuthResult> {
    if (!this.hub) return { ok: false, status: 404, code: "FEDERATION_NOT_HUB", message: "This machine is not a federation hub." };
    return this.hub.authenticate(headers);
  }

  attachLink(socket: WebSocket, auth: Extract<LinkAuthResult, { ok: true }>): void {
    if (!this.hub) { closeQuietly(socket, 1001, "not a hub"); return; }
    this.hub.attach(socket, auth);
  }

  /** The member behind a `/d/…` request, when a member made it for its page. Only a hub accepts these. */
  verifyDeviceRequest(headers: Record<string, unknown>): string | null {
    return this.hub?.verifyDeviceRequest(headers) ?? null;
  }

  forwardHttp(target: string, head: RequestHead, body: Uint8Array): Promise<ExecutedResponse> {
    if (this.config.mode !== "off" && target === this.config.deviceId) return this.options.executeLocal(head, body);
    if (this.hub) return this.hub.request(target, head, body);
    if (this.member) return this.member.forwardHttp(target, head, body);
    return Promise.reject(new FederationError(404, "FEDERATION_OFF", "Multi-device access is not enabled on this machine."));
  }

  forwardSocket(target: string, client: WebSocket): void {
    if (this.config.mode !== "off" && target === this.config.deviceId) {
      relaySockets(client, this.options.openLocal(), 1011, "local socket failed");
      return;
    }
    if (this.hub) { this.hub.connect(target, client); return; }
    if (this.member) { this.member.forwardSocket(target, client); return; }
    closeQuietly(client, FederationClose.deviceUnavailable, "federation off");
  }

  // ---------------------------------------------------------------- admin (loopback page only)

  adminView(): FederationAdminView {
    return {
      mode: this.config.mode,
      deviceId: this.config.deviceId,
      name: this.config.name,
      publicUrl: this.config.publicUrl,
      hubUrl: this.config.hub?.url ?? null,
      link: { state: this.member?.state ?? null, error: this.member?.error ?? null },
      devices: this.hub?.entries() ?? [],
    };
  }

  enableHub(name: unknown, publicUrl: unknown): Promise<FederationAdminView> {
    return this.serial(async () => {
      const url = normalizeHubUrl(publicUrl);
      if (!url) throw new FederationError(400, "FEDERATION_PUBLIC_URL_INVALID", "Enter the public https:// address of this machine, without a path.");
      this.config = { ...this.config, mode: "hub", name: cleanName(name, this.config.name || defaultDeviceName()), publicUrl: url, hub: null };
      await this.store.writeConfig(this.config);
      await this.store.clearDirectory();
      await this.startRole();
      return this.adminView();
    });
  }

  join(joinCode: unknown, name: unknown): Promise<FederationAdminView> {
    return this.serial(async () => {
      const code = decodeJoinCode(joinCode);
      if (!code) throw new FederationError(400, "FEDERATION_JOIN_CODE_INVALID", "That join code is not valid. Copy it again from the hub.");
      this.config = { ...this.config, mode: "member", name: cleanName(name, this.config.name || defaultDeviceName()), publicUrl: null, hub: { url: code.hub, token: code.token, access: code.access } };
      await this.store.writeConfig(this.config);
      await this.store.clearDirectory();
      await this.startRole();
      return this.adminView();
    });
  }

  /** Back to a single machine. Nothing but the federation settings changes. */
  leave(): Promise<FederationAdminView> {
    return this.serial(async () => {
      this.config = { ...this.config, mode: "off", hub: null };
      await this.store.writeConfig(this.config);
      await this.store.clearDirectory();
      await this.startRole();
      return this.adminView();
    });
  }

  /** For a copied data folder: a new identity, which needs a new join code. */
  resetIdentity(): Promise<FederationAdminView> {
    return this.serial(async () => {
      this.config = { ...this.config, mode: "off", hub: null, publicUrl: null, deviceId: randomUUID() };
      await this.store.writeConfig(this.config);
      await this.store.clearDirectory();
      await this.startRole();
      return this.adminView();
    });
  }

  retry(): FederationAdminView {
    this.member?.retry();
    return this.adminView();
  }

  async addDevice(name: unknown, accessId: unknown, accessSecret: unknown): Promise<{ joinCode: string; view: FederationAdminView }> {
    if (!this.hub) throw new FederationError(400, "FEDERATION_NOT_HUB", "Only the hub can add devices.");
    const id = typeof accessId === "string" ? accessId.trim() : "";
    const secret = typeof accessSecret === "string" ? accessSecret.trim() : "";
    if (Boolean(id) !== Boolean(secret)) throw new FederationError(400, "FEDERATION_ACCESS_INCOMPLETE", "Enter both the service token id and its secret, or neither.");
    const joinCode = await this.hub.addDevice(cleanName(name, "Promptor"), id ? { id, secret } : null);
    return { joinCode, view: this.adminView() };
  }

  async renameDevice(key: string, name: unknown): Promise<FederationAdminView> {
    if (!this.hub) throw new FederationError(400, "FEDERATION_NOT_HUB", "Only the hub can rename devices.");
    const clean = cleanName(name, "");
    if (!clean) throw new FederationError(400, "FEDERATION_NAME_EMPTY", "A device needs a name.");
    await this.hub.renameDevice(key, clean);
    if (key === this.config.deviceId) {
      this.config = { ...this.config, name: clean };
      await this.store.writeConfig(this.config);
    }
    return this.adminView();
  }

  async removeDevice(key: string): Promise<FederationAdminView> {
    if (!this.hub) throw new FederationError(400, "FEDERATION_NOT_HUB", "Only the hub can remove devices.");
    await this.hub.removeDevice(key);
    return this.adminView();
  }

  close(): void {
    this.stopRole();
  }
}
