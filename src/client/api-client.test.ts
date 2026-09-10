import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { E2EE_BODY_CONTENT_TYPE } from "../shared/e2ee-http.js";
import { deriveMasterKey } from "../server/e2ee-key-material.js";
import { openHttpBody } from "../server/e2ee-http-body.js";
import { api, apiResponse } from "./api-client.js";
import { deriveSessionKey, type SessionKey } from "./e2ee-client.js";
import { applyRequirement, useKey } from "./e2ee-gate.js";

describe("HTTP request encryption and errors", () => {
  let master: Buffer;
  let key: SessionKey;
  const fetchMock = vi.fn<typeof fetch>();

  beforeAll(async () => {
    const salt = Buffer.alloc(16, 7);
    master = await deriveMasterKey("test passphrase", salt, 60_000);
    key = await deriveSessionKey("test passphrase", salt.toString("base64"), 60_000);
  });

  beforeEach(async () => {
    await applyRequirement({ required: false });
    await useKey(key, false);
    await applyRequirement({ required: true, fingerprint: key.fingerprint });
    fetchMock.mockReset().mockImplementation(async () => Response.json({ data: { ok: true } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await applyRequirement({ required: false });
  });

  it.each(["POST", "DELETE", "PUT", "PATCH"])("seals an empty %s action instead of sending zero ciphertext bytes", async (method) => {
    await api("/api/action", { method });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("content-type")).toBe(E2EE_BODY_CONTENT_TYPE);
    expect(init.body).toBeInstanceOf(Uint8Array);
    expect(openHttpBody(master, init.body as Uint8Array)).toBe("{}");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([null, ""])("seals an explicitly empty body (%s)", async (body) => {
    await apiResponse("/api/action", { method: "POST", body });
    expect(openHttpBody(master, fetchMock.mock.calls[0]![1]!.body as Uint8Array)).toBe("{}");
  });

  it.each([undefined, "GET", "HEAD"])("does not attach an encrypted entity to a read (%s)", async (method) => {
    await api("/api/resource", { method });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("keeps prompt contents encrypted and unchanged", async () => {
    const body = JSON.stringify({ text: "private prompt\n第二行" });
    await api("/api/prompts", { method: "POST", body });
    expect(openHttpBody(master, fetchMock.mock.calls[0]![1]!.body as Uint8Array)).toBe(body);
  });

  it("leaves local non-encrypted actions bodyless", async () => {
    await applyRequirement({ required: false });
    await api("/api/action", { method: "DELETE" });
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has("content-type")).toBe(false);
  });

  it("does not submit an action without the required key", async () => {
    await applyRequirement({ required: false });
    await applyRequirement({ required: true, fingerprint: key.fingerprint });
    await expect(api("/api/action", { method: "DELETE" })).rejects.toMatchObject({ code: "E2EE_LOCKED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([api, apiResponse])("preserves Fastify parser errors instead of reducing them to HTTP 403", async (call) => {
    fetchMock.mockResolvedValueOnce(Response.json({
      statusCode: 403, error: "Forbidden", code: "E2EE_BODY_UNREADABLE", message: "The encrypted request could not be opened.",
    }, { status: 403 }));
    await expect(call("/api/action", { method: "POST" })).rejects.toMatchObject({
      code: "E2EE_BODY_UNREADABLE", status: 403, message: "The encrypted request could not be opened.", retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([api, apiResponse])("preserves application errors and safely handles non-JSON proxy errors", async (call) => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "TEST_ERROR", message: "reason", retryable: true, details: { field: "test" } } }, { status: 409 }));
    await expect(call("/api/resource")).rejects.toMatchObject({ code: "TEST_ERROR", message: "reason", status: 409, retryable: true, details: { field: "test" } });
    fetchMock.mockResolvedValueOnce(new Response("<html>proxy denied</html>", { status: 403 }));
    await expect(call("/api/resource")).rejects.toMatchObject({ code: "HTTP_ERROR", message: "HTTP 403", status: 403 });
  });
});
