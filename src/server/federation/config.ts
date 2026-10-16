import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DirectoryDevice, FederationMode } from "../../shared/federation-protocol.js";
import { writeFileAtomicWithRetry } from "../storage.js";

/**
 * Everything federation keeps on disk, all of it under `data/private/` --
 * which git already ignores -- and none of it touching the conversations.
 *
 *   federation.json            every machine: mode, its own id and name; a
 *                              member also keeps the hub's address and its
 *                              credentials
 *   federation-devices.json    the hub only: who may join
 *   federation-directory.json  a member only: the last list the hub sent, so
 *                              its page keeps its layout while the hub is away
 */

const AccessSchema = z.object({ id: z.string().min(1).max(256), secret: z.string().min(1).max(512) });

const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  mode: z.enum(["off", "hub", "member"]).default("off"),
  deviceId: z.string().uuid(),
  name: z.string().min(1).max(80),
  /** Hub only: the public address members connect to, put into join codes. */
  publicUrl: z.string().max(512).nullable().default(null),
  /** Member only. */
  hub: z.object({
    url: z.string().max(512),
    token: z.string().min(16).max(256),
    access: AccessSchema.nullable().default(null),
  }).nullable().default(null),
});
export type FederationConfig = z.infer<typeof ConfigSchema>;

const EntrySchema = z.object({
  /** Null until the member first connects; the token binds to whichever id presents it first. */
  deviceId: z.string().uuid().nullable(),
  name: z.string().min(1).max(80),
  /** SHA-256 of the device token, hex. Null for the hub's own entry, which never connects to itself. */
  tokenSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  addedAt: z.string(),
});
export type DeviceEntry = z.infer<typeof EntrySchema>;

const RegistrySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  devices: z.array(EntrySchema).max(64).default([]),
});
export type DeviceRegistry = z.infer<typeof RegistrySchema>;

const DirectorySchema = z.object({
  schemaVersion: z.literal(1).default(1),
  devices: z.array(z.object({ id: z.string(), name: z.string(), online: z.boolean(), version: z.string().nullable() })).max(64).default([]),
});

/** Ten devices is the documented ceiling; the hard stop leaves room for a pending entry or two. */
export const MAX_DEVICES = 16;

export function defaultDeviceName(): string {
  const host = os.hostname().trim();
  return (host || "Promptor").slice(0, 80);
}

export class FederationStore {
  readonly configPath: string;
  readonly registryPath: string;
  readonly directoryPath: string;

  constructor(dataDir: string) {
    const privateDir = path.join(dataDir, "private");
    this.configPath = path.join(privateDir, "federation.json");
    this.registryPath = path.join(privateDir, "federation-devices.json");
    this.directoryPath = path.join(privateDir, "federation-directory.json");
  }

  /** The stored configuration, or a fresh `off` one with an identity ready to be used. */
  async readConfig(): Promise<FederationConfig> {
    const stored = await readJson(this.configPath);
    const parsed = stored === undefined ? null : ConfigSchema.safeParse(stored);
    if (parsed?.success) return parsed.data;
    if (parsed && !parsed.success) console.warn("[promptor] federation.json is not valid; federation stays off until it is fixed or reset.");
    return { schemaVersion: 1, mode: "off", deviceId: randomUUID(), name: defaultDeviceName(), publicUrl: null, hub: null };
  }

  async writeConfig(config: FederationConfig): Promise<void> {
    await writeJson(this.configPath, ConfigSchema.parse(config));
  }

  async readRegistry(): Promise<DeviceRegistry> {
    const parsed = RegistrySchema.safeParse(await readJson(this.registryPath) ?? {});
    return parsed.success ? parsed.data : { schemaVersion: 1, devices: [] };
  }

  async writeRegistry(registry: DeviceRegistry): Promise<void> {
    await writeJson(this.registryPath, RegistrySchema.parse(registry));
  }

  async readDirectory(): Promise<DirectoryDevice[]> {
    const parsed = DirectorySchema.safeParse(await readJson(this.directoryPath) ?? {});
    return parsed.success ? parsed.data.devices : [];
  }

  async writeDirectory(devices: DirectoryDevice[]): Promise<void> {
    await writeJson(this.directoryPath, { schemaVersion: 1, devices });
  }

  async clearDirectory(): Promise<void> {
    await fs.rm(this.directoryPath, { force: true }).catch(() => undefined);
  }
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    return null;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomicWithRetry(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function newDeviceToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant time, because it is a credential, even though the digest leaks nothing useful. */
export function digestMatches(token: string, digest: string | null): boolean {
  if (!digest) return false;
  const a = Buffer.from(tokenDigest(token), "hex");
  const b = Buffer.from(digest, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type JoinCode = { hub: string; token: string; access: { id: string; secret: string } | null };

const JOIN_PREFIX = "pj1.";

/**
 * Everything a member needs, in one string the reader copies once.
 *
 * It holds a credential, so it is shown a single time on the hub's own page
 * and is never stored there; the hub keeps only the token's digest.
 */
export function encodeJoinCode(code: JoinCode): string {
  return JOIN_PREFIX + Buffer.from(JSON.stringify(code), "utf8").toString("base64url");
}

export function decodeJoinCode(text: unknown): JoinCode | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(JOIN_PREFIX) || trimmed.length > 4_096) return null;
  try {
    const value = JSON.parse(Buffer.from(trimmed.slice(JOIN_PREFIX.length), "base64url").toString("utf8"));
    const hub = normalizeHubUrl(value?.hub);
    if (!hub || typeof value?.token !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)) return null;
    const access = value.access && typeof value.access.id === "string" && typeof value.access.secret === "string"
      ? { id: value.access.id, secret: value.access.secret }
      : null;
    return { hub, token: value.token, access };
  } catch {
    return null;
  }
}

/**
 * The hub's origin, or null.
 *
 * HTTPS only, because the link carries credentials and terminals. Plain HTTP
 * is accepted for a loopback hub, which is what two instances on one machine
 * -- and the tests -- use.
 */
export function normalizeHubUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isFederationMode(value: unknown): value is FederationMode {
  return value === "off" || value === "hub" || value === "member";
}
