import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FederationStore,
  decodeJoinCode,
  digestMatches,
  encodeJoinCode,
  newDeviceToken,
  normalizeHubUrl,
  tokenDigest,
} from "./config.js";

describe("join codes", () => {
  it("carry the hub, the token and the Access pass in one string", () => {
    const token = newDeviceToken();
    const code = encodeJoinCode({ hub: "https://promptor.example.com", token, access: { id: "id.access", secret: "s3cret" } });
    expect(code.startsWith("pj1.")).toBe(true);
    expect(decodeJoinCode(`  ${code}\n`)).toEqual({ hub: "https://promptor.example.com", token, access: { id: "id.access", secret: "s3cret" } });
  });

  it("refuse anything malformed rather than guessing", () => {
    expect(decodeJoinCode("pj1.not-base64-json")).toBeNull();
    expect(decodeJoinCode("hello")).toBeNull();
    expect(decodeJoinCode(encodeJoinCode({ hub: "http://promptor.example.com", token: newDeviceToken(), access: null }))).toBeNull();
    expect(decodeJoinCode(encodeJoinCode({ hub: "https://promptor.example.com", token: "short", access: null }))).toBeNull();
  });
});

describe("the hub address", () => {
  it("is https, or plain http on loopback for two instances on one machine", () => {
    expect(normalizeHubUrl("https://promptor.example.com/")).toBe("https://promptor.example.com");
    expect(normalizeHubUrl("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
    expect(normalizeHubUrl("http://promptor.example.com")).toBeNull();
    expect(normalizeHubUrl("https://user:pw@promptor.example.com")).toBeNull();
    expect(normalizeHubUrl("https://promptor.example.com/sub")).toBeNull();
    expect(normalizeHubUrl("ftp://x")).toBeNull();
  });
});

describe("device tokens", () => {
  it("are kept as digests and compared in constant time", () => {
    const token = newDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(digestMatches(token, tokenDigest(token))).toBe(true);
    expect(digestMatches(newDeviceToken(), tokenDigest(token))).toBe(false);
    expect(digestMatches(token, null)).toBe(false);
  });
});

describe("the federation files", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "promptor-federation-store-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  it("start off, with an identity ready, and round-trip", async () => {
    const store = new FederationStore(root);
    const fresh = await store.readConfig();
    expect(fresh.mode).toBe("off");
    expect(fresh.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    await store.writeConfig({ ...fresh, mode: "hub", publicUrl: "https://promptor.example.com" });
    expect((await store.readConfig())).toMatchObject({ mode: "hub", deviceId: fresh.deviceId });
    // Under data/private, which git already ignores.
    expect(store.configPath).toContain(path.join(root, "private"));
  });
});
