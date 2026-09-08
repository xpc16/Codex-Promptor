import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";
import { redactForRemote, redactForScope } from "./e2ee-redaction.js";
import { decodeBase64 } from "../shared/e2ee-keys.js";
import { E2EE_BODY_HEADER } from "../shared/e2ee-http.js";
import { deriveMasterKey } from "./e2ee-key-material.js";
import { openHttpBody } from "./e2ee-http-body.js";

/** Distinctive enough that finding it anywhere is unambiguous. */
const PASSPHRASE = "correct-horse-battery-staple-4f2a9c";
const REMOTE_HOST = "promptor.example.com";
const E2EE_SALT = "c2FsdA==";

const e2eeSession = (over: Record<string, unknown> = {}) => ({
  provider: "e2ee",
  state: "ready",
  workingDirectory: PASSPHRASE,
  threadId: null,
  e2ee: { salt: E2EE_SALT, iterations: 600000, fingerprint: "K7M2-9QXF" },
  ...over,
});

describe("taking the passphrase out of what leaves this machine", () => {
  it("nulls it wherever a p2p tab is found, however deep", () => {
    // The shapes it actually travels in: a tab on its own, the index, a
    // delta's upserts, a bundle inside a snapshot.
    const message = {
      type: "snapshot",
      data: { tab: { id: "t1", session: e2eeSession() }, prompts: { prompts: [] } },
      index: { tabs: [{ id: "t1", session: e2eeSession() }] },
      delta: { tabs: { upserts: [{ id: "t1", session: e2eeSession() }] } },
    };
    expect(JSON.stringify(redactForRemote(message))).not.toContain(PASSPHRASE);
  });

  it("leaves the tab itself standing", () => {
    // The far end has to see that this tab exists, or it cannot know
    // encryption is on. What it does not need is what was typed into it.
    const redacted = redactForRemote({ session: e2eeSession() }) as any;
    expect(redacted.session.provider).toBe("e2ee");
    expect(redacted.session.workingDirectory).toBeNull();
    expect(redacted.session.e2ee.salt).toBe(E2EE_SALT);
  });

  it("does not touch a conversation's working directory", () => {
    const kept = { session: { provider: "codex", workingDirectory: "D:/work", threadId: "t" } };
    expect(redactForRemote(kept)).toBe(kept);
  });

  it("returns the same object when there was nothing to take out", () => {
    // Most outbound messages carry no tab at all; none of them should pay for
    // a clone of themselves.
    const message = { type: "terminal.screen", rows: [{ cells: "abc" }] };
    expect(redactForRemote(message)).toBe(message);
    expect(redactForRemote({ session: e2eeSession({ workingDirectory: null }) })).toBeTruthy();
  });

  it("keeps loopback unredacted, because that is where it was typed", () => {
    const message = { session: e2eeSession() };
    expect(redactForScope(message, "local")).toBe(message);
    expect(JSON.stringify(redactForScope(message, "tunnel"))).not.toContain(PASSPHRASE);
    expect(JSON.stringify(redactForScope(message, "remote"))).not.toContain(PASSPHRASE);
  });

  it("survives a cycle rather than hanging on one", () => {
    const cyclic: any = { session: e2eeSession() };
    cyclic.self = cyclic;
    expect(() => redactForRemote(cyclic)).not.toThrow();
  });
});

describe("the passphrase over a real connection", () => {
  let app: PromptorApp;
  let root: string;
  let address: string;
  let tabId: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-e2ee-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    const tab = await app.promptor.storage.createTab("加密");
    tabId = tab.id;
    await app.promptor.storage.updateTab(tabId, (current) => ({
      ...current,
      session: { ...current.session, ...e2eeSession() } as never,
      updatedAt: isoNow(),
    }));
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.close();
      setTimeout(resolve, 200);
    })));
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const fetchAs = (host: string, url: string) => app.inject({
    method: "GET",
    url,
    headers: { "x-codex-promptor-token": app.promptor.token, host },
  });

  it("is served to loopback and withheld from everything else", async () => {
    // Asserting the result, not that a function was called: every response a
    // remote can ask for, searched for the passphrase itself.
    //
    // Opened before searching, now that bodies are sealed. Searching the
    // ciphertext would pass for any content whatsoever and prove nothing --
    // the point is that the passphrase is absent from what a reader holding
    // the key can see, not merely from what the relay can.
    const master = await deriveMasterKey(PASSPHRASE, Buffer.from(decodeBase64(E2EE_SALT)), 600_000);
    for (const url of ["/api/bootstrap", `/api/tabs/${tabId}`]) {
      const local = await fetchAs("127.0.0.1:4317", url);
      expect(local.statusCode, url).toBe(200);
      expect(local.body, `${url} on loopback`).toContain(PASSPHRASE);

      const remote = await fetchAs(REMOTE_HOST, url);
      expect(remote.statusCode, url).toBe(200);
      const plain = remote.headers[E2EE_BODY_HEADER]
        ? openHttpBody(master, new Uint8Array(remote.rawPayload))
        : remote.body;
      expect(plain, `${url} could be opened`).not.toBeNull();
      expect(plain!, `${url} over the tunnel`).not.toContain(PASSPHRASE);
      // Still visible as a tab, so the far end knows encryption is on.
      expect(plain!, `${url} still names the tab`).toContain(tabId);
    }
  });

  it("is withheld over a WebSocket that is not loopback", async () => {
    const viewer = async (host?: string) => {
      const url = `${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`;
      const socket = new WebSocket(url, host ? { headers: { host } } : undefined);
      sockets.push(socket);
      const frames: string[] = [];
      socket.on("message", (raw: Buffer) => frames.push(raw.toString()));
      await new Promise<void>((resolve, reject) => { socket.on("open", () => resolve()); socket.on("error", reject); });
      socket.send(JSON.stringify({ type: "subscribe", tabIds: [tabId], index: true, snapshots: true, details: true, terminals: {} }));
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline && !frames.some((frame) => frame.includes(tabId))) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return frames.join("\n");
    };

    expect(await viewer(), "loopback viewer").toContain(PASSPHRASE);
    expect(await viewer(REMOTE_HOST), "tunnel viewer").not.toContain(PASSPHRASE);
  });
});

describe("setting the key", () => {
  let app: PromptorApp;
  let root: string;
  let tabId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-e2ee-setup-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    await app.ready();
    tabId = (await app.promptor.storage.createTab("加密")).id;
  });

  afterEach(async () => {
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const open = (host: string, origin: string, payload: Record<string, unknown>) => app.inject({
    method: "POST",
    url: `/api/tabs/${tabId}/session`,
    headers: { "x-codex-promptor-token": app.promptor.token, host, origin },
    payload: { provider: "e2ee", ...payload } as never,
  });

  it("is refused from anywhere but this machine", async () => {
    // Letting the far end choose the key it will then be checked against is
    // the same as having no key at all.
    const remote = await open(REMOTE_HOST, `https://${REMOTE_HOST}`, { workingDirectory: PASSPHRASE });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toMatchObject({ error: { code: "E2EE_LOCAL_ONLY" } });
    expect((await app.promptor.storage.getTabMeta(tabId)).session.provider).not.toBe("e2ee");
  });

  it("derives a salt and a fingerprint, and keeps the passphrase local", async () => {
    const response = await open("127.0.0.1:4317", "http://127.0.0.1:4317", { workingDirectory: PASSPHRASE });
    expect(response.statusCode).toBe(200);
    const session = (await app.promptor.storage.getTabMeta(tabId)).session;
    expect(session.provider).toBe("e2ee");
    expect(session.workingDirectory).toBe(PASSPHRASE);
    expect(session.e2ee?.iterations).toBe(600000);
    expect(session.e2ee?.fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    // No conversation was started: it is a switch, not a session.
    expect(session.threadId).toBeNull();
  });

  it("takes an empty box as keeping the key already set", async () => {
    await open("127.0.0.1:4317", "http://127.0.0.1:4317", { workingDirectory: PASSPHRASE });
    const before = (await app.promptor.storage.getTabMeta(tabId)).session.e2ee?.fingerprint;
    const again = await open("127.0.0.1:4317", "http://127.0.0.1:4317", { workingDirectory: "" });
    expect(again.statusCode).toBe(200);
    const after = (await app.promptor.storage.getTabMeta(tabId)).session;
    expect(after.workingDirectory).toBe(PASSPHRASE);
    // A fresh salt each time, so the same passphrase does not derive the same
    // key twice -- and the reader is told to re-pair by the fingerprint moving.
    expect(after.e2ee?.fingerprint).not.toBe(before);
  });

  it("refuses to turn on with nothing to turn on with", async () => {
    const empty = await open("127.0.0.1:4317", "http://127.0.0.1:4317", { workingDirectory: "   " });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "E2EE_PASSPHRASE_REQUIRED" } });
  });
});
