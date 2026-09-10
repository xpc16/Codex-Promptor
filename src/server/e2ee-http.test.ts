import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../client/api-client.js";
import { deriveSessionKey } from "../client/e2ee-client.js";
import { applyRequirement, useKey } from "../client/e2ee-gate.js";
import { decodeBase64 } from "../shared/e2ee-keys.js";
import { E2EE_BODY_CONTENT_TYPE, E2EE_BODY_HEADER } from "../shared/e2ee-http.js";
import { createApp, type PromptorApp } from "./app.js";
import { deriveMasterKey } from "./e2ee-key-material.js";
import { openHttpBody, sealHttpBody } from "./e2ee-http-body.js";

const PASSPHRASE = "一句只有我知道的话 42";
const REMOTE_HOST = "promptor.example.com";
const LOCAL_HOST = "127.0.0.1:4317";

describe("sealing an HTTP body", () => {
  const master = Buffer.alloc(32, 7);

  it("round-trips what it sealed", () => {
    expect(openHttpBody(master, new Uint8Array(sealHttpBody(master, '{"a":1}')))).toBe('{"a":1}');
  });

  it("round-trips a body large enough to be compressed first", () => {
    // Compression happens before the seal, never after: ciphertext does not
    // compress, so the other order spends CPU to send more bytes.
    const large = JSON.stringify({ text: "终端输出 ".repeat(400) });
    const sealed = sealHttpBody(master, large);
    expect(sealed.length, "the compressed body is smaller than what went in").toBeLessThan(large.length);
    expect(openHttpBody(master, new Uint8Array(sealed))).toBe(large);
  });

  it("gives nothing to a different key", () => {
    const sealed = new Uint8Array(sealHttpBody(master, '{"a":1}'));
    expect(openHttpBody(Buffer.alloc(32, 8), sealed)).toBeNull();
  });

  it("gives nothing for a body a relay changed", () => {
    const sealed = new Uint8Array(sealHttpBody(master, '{"a":1}'));
    sealed[sealed.length - 1] ^= 0xff;
    expect(openHttpBody(master, sealed)).toBeNull();
    expect(openHttpBody(master, sealed.subarray(0, 4)), "or truncated").toBeNull();
  });
});

describe("what actually crosses the tunnel", () => {
  let app: PromptorApp;
  let root: string;
  let tabId: string;
  let switchTabId: string;
  let master: Buffer;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-e2ee-http-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    await app.ready();
    switchTabId = (await app.promptor.storage.createTab("加密")).id;
    await app.inject({
      method: "POST",
      url: `/api/tabs/${switchTabId}/session`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: LOCAL_HOST, origin: `http://${LOCAL_HOST}` },
      payload: { provider: "e2ee", workingDirectory: PASSPHRASE } as never,
    });
    const e2ee = (await app.promptor.storage.getTabMeta(switchTabId)).session.e2ee!;
    master = await deriveMasterKey(PASSPHRASE, Buffer.from(decodeBase64(e2ee.salt)), e2ee.iterations);
    tabId = (await app.promptor.storage.createTab("对话")).id;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await applyRequirement({ required: false });
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const get = (host: string, url: string) => app.inject({
    method: "GET", url,
    headers: { "x-codex-promptor-token": app.promptor.token, host },
  });

  it("sends a tab as ciphertext, and the same tab in the clear to loopback", async () => {
    const local = await get(LOCAL_HOST, `/api/tabs/${tabId}`);
    expect(local.headers[E2EE_BODY_HEADER]).toBeUndefined();
    expect(local.body).toContain("对话");

    const remote = await get(REMOTE_HOST, `/api/tabs/${tabId}`);
    expect(remote.statusCode).toBe(200);
    expect(remote.headers[E2EE_BODY_HEADER], "the response says which key opens it").toBeTruthy();
    expect(remote.rawPayload.toString("utf8"), "the name is not in the bytes").not.toContain("对话");

    const opened = openHttpBody(master, new Uint8Array(remote.rawPayload));
    expect(opened, "and the key opens it").not.toBeNull();
    expect(JSON.parse(opened!).data.tab.name).toBe("对话");
  });

  it("leaves bootstrap readable, because it is what asks for the key", async () => {
    const remote = await get(REMOTE_HOST, "/api/bootstrap");
    expect(remote.headers[E2EE_BODY_HEADER]).toBeUndefined();
    expect(remote.json().data.e2ee.required).toBe(true);
  });

  it("still answers 304 rather than sealing an empty body", async () => {
    // Revalidation is what keeps repeated opens from re-sending the whole tab;
    // encryption must not cost that.
    const first = await get(REMOTE_HOST, `/api/tabs/${tabId}`);
    const etag = String(first.headers.etag);
    const again = await app.inject({
      method: "GET", url: `/api/tabs/${tabId}`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: REMOTE_HOST, "if-none-match": etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.rawPayload.length).toBe(0);
  });

  it("takes a sealed prompt and refuses one that is not", async () => {
    // The prompt is the request body. Encrypting only responses would have
    // left the most sensitive half of the conversation in the clear.
    const sealed = sealHttpBody(master, JSON.stringify({ text: "一条只有我能读的提示词" }));
    const accepted = await app.inject({
      method: "POST", url: `/api/tabs/${tabId}/prompts`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: REMOTE_HOST, "content-type": E2EE_BODY_CONTENT_TYPE },
      payload: sealed,
    });
    expect(accepted.statusCode).toBe(200);
    const stored = await app.promptor.storage.readTab(tabId);
    expect(stored.prompts.prompts[0]?.text).toBe("一条只有我能读的提示词");

    const forged = await app.inject({
      method: "POST", url: `/api/tabs/${tabId}/prompts`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: REMOTE_HOST, "content-type": E2EE_BODY_CONTENT_TYPE },
      payload: Buffer.from(sealHttpBody(Buffer.alloc(32, 9), JSON.stringify({ text: "从别处来的" }))),
    });
    expect(forged.statusCode).toBe(403);
  });

  it("sends bodyless page actions through the real encrypted parser without a false 403", async () => {
    const e2ee = (await app.promptor.storage.getTabMeta(switchTabId)).session.e2ee!;
    const pageKey = await deriveSessionKey(PASSPHRASE, e2ee.salt, e2ee.iterations);
    await useKey(pageKey, false);
    await applyRequirement({ required: true, fingerprint: e2ee.fingerprint });
    const statuses: number[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init.headers));
      const response = await app.inject({
        url, method: init.method as "GET" | "POST" | "DELETE",
        headers: { ...headers, host: REMOTE_HOST, "x-codex-promptor-token": app.promptor.token },
        payload: init.body ? Buffer.from(init.body as Uint8Array) : undefined,
      });
      statuses.push(response.statusCode);
      return new Response(Uint8Array.from(response.rawPayload), {
        status: response.statusCode,
        headers: { [E2EE_BODY_HEADER]: String(response.headers[E2EE_BODY_HEADER] ?? "") },
      });
    });

    await api(`/api/tabs/${tabId}/prompts`, { method: "POST", body: JSON.stringify({ text: "delete this fixture only" }) });
    const promptId = (await app.promptor.storage.readTab(tabId)).prompts.prompts[0]!.id;
    await api(`/api/tabs/${tabId}/prompts/${promptId}`, { method: "DELETE" });
    expect((await app.promptor.storage.readTab(tabId)).prompts.prompts).toHaveLength(0);
    // An unconfigured fixture reaches the route's normal validation, without
    // ever launching a real shell or touching a user's running conversation.
    for (const route of ["terminal/reopen", "session/close"]) {
      await expect(api(`/api/tabs/${tabId}/${route}`, { method: "POST" }))
        .rejects.toMatchObject({ code: "SESSION_NOT_READY", status: 400 });
    }
    expect(statuses).toEqual([200, 200, 400, 400]);

    // A valid encrypted empty action must not weaken the local-only switch.
    await expect(api(`/api/tabs/${switchTabId}/session/close`, { method: "POST" }))
      .rejects.toMatchObject({ code: "E2EE_LOCAL_ONLY", status: 403 });
    expect((await app.promptor.storage.getTabMeta(switchTabId)).session.state).toBe("ready");
  });
});
