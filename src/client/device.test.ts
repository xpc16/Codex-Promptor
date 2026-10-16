import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { E2EE_BODY_CONTENT_TYPE } from "../shared/e2ee-http.js";
import { deriveMasterKey } from "../server/e2ee-key-material.js";
import { openHttpBody } from "../server/e2ee-http-body.js";
import { deriveSessionKey, type SessionKey } from "./e2ee-client.js";
import { deviceFor, homeDevice, setHomeDeviceId, splitTabKey } from "./device.js";

/**
 * A page that reaches several machines (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md §9.2).
 * The home device must behave exactly as the page always has; every other
 * device lives under its own prefix, its own key and its own cache keys.
 */
describe("devices", () => {
  const REMOTE = "1f0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a5b";

  it("leaves the home device's addresses and cache keys as they were", () => {
    const home = homeDevice();
    expect(home.prefix).toBe("");
    expect(home.cacheKey("tab-1")).toBe("tab-1");
    expect(home.wsUrl()).toMatch(/\/ws(\?|$)/);
    // Learning its federation id changes the label only.
    expect(setHomeDeviceId("aaaaaaaa-0000-4000-8000-000000000000").cacheKey("tab-1")).toBe("tab-1");
    setHomeDeviceId(null);
  });

  it("puts every other device under its own prefix, cache keys and gate", () => {
    const remote = deviceFor(REMOTE);
    expect(remote.prefix).toBe(`/d/${REMOTE}`);
    expect(remote.cacheKey("tab-1")).toBe(`${REMOTE}/tab-1`);
    expect(remote.wsUrl()).toContain(`/d/${REMOTE}/ws`);
    expect(remote.native).toBe(false);
    expect(remote.gate).not.toBe(homeDevice().gate);
    // One object per machine for the life of the page.
    expect(deviceFor(REMOTE)).toBe(remote);
  });

  it("reads a tab key back into its device and tab", () => {
    expect(splitTabKey("tab-1")).toEqual({ deviceId: null, tabId: "tab-1" });
    expect(splitTabKey(`${REMOTE}/tab-1`)).toEqual({ deviceId: REMOTE, tabId: "tab-1" });
  });
});

describe("a request to another machine", () => {
  const REMOTE = "2a0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a5c";
  const fetchMock = vi.fn<typeof fetch>();
  let master: Buffer;
  let key: SessionKey;

  beforeAll(async () => {
    const salt = Buffer.alloc(16, 9);
    master = await deriveMasterKey("家里的口令", salt, 60_000);
    key = await deriveSessionKey("家里的口令", salt.toString("base64"), 60_000);
  });

  afterEach(() => { vi.unstubAllGlobals(); fetchMock.mockReset(); });

  it("goes to /d/<id>/… but is sealed as the /api/… path the owner will see", async () => {
    // The trap this guards: deciding encryption on the network path, which
    // does not start with /api/, would send the prompt in the clear.
    const remote = deviceFor(REMOTE);
    await remote.gate.useKey(key, false);
    await remote.gate.applyRequirement({ required: true, fingerprint: key.fingerprint });
    fetchMock.mockImplementation(async () => Response.json({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);

    const body = JSON.stringify({ text: "只给那台机器看的 prompt" });
    await remote.api("/api/tabs/t/prompts", { method: "POST", body });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/d/${REMOTE}/api/tabs/t/prompts`);
    expect(new Headers(init!.headers).get("content-type")).toBe(E2EE_BODY_CONTENT_TYPE);
    expect(openHttpBody(master, init!.body as Uint8Array)).toBe(body);
  });

  it("does not borrow the home device's key", async () => {
    const other = deviceFor("3a0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a5d");
    await other.gate.applyRequirement({ required: true, fingerprint: "AAAA-BBBB" });
    vi.stubGlobal("fetch", fetchMock);
    await expect(other.api("/api/tabs/t/prompts", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "E2EE_LOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
