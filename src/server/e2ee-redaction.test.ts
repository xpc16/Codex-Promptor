import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";
import { redactForRemote, redactForScope } from "./e2ee-redaction.js";

/** Distinctive enough that finding it anywhere is unambiguous. */
const PASSPHRASE = "correct-horse-battery-staple-4f2a9c";
const REMOTE_HOST = "promptor.example.com";

const p2pSession = (over: Record<string, unknown> = {}) => ({
  provider: "p2p",
  state: "ready",
  workingDirectory: PASSPHRASE,
  threadId: null,
  e2ee: { salt: "c2FsdA", iterations: 600000, fingerprint: "K7M2-9QXF" },
  ...over,
});

describe("taking the passphrase out of what leaves this machine", () => {
  it("nulls it wherever a p2p tab is found, however deep", () => {
    // The shapes it actually travels in: a tab on its own, the index, a
    // delta's upserts, a bundle inside a snapshot.
    const message = {
      type: "snapshot",
      data: { tab: { id: "t1", session: p2pSession() }, prompts: { prompts: [] } },
      index: { tabs: [{ id: "t1", session: p2pSession() }] },
      delta: { tabs: { upserts: [{ id: "t1", session: p2pSession() }] } },
    };
    expect(JSON.stringify(redactForRemote(message))).not.toContain(PASSPHRASE);
  });

  it("leaves the tab itself standing", () => {
    // The far end has to see that this tab exists, or it cannot know
    // encryption is on. What it does not need is what was typed into it.
    const redacted = redactForRemote({ session: p2pSession() }) as any;
    expect(redacted.session.provider).toBe("p2p");
    expect(redacted.session.workingDirectory).toBeNull();
    expect(redacted.session.e2ee.salt).toBe("c2FsdA");
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
    expect(redactForRemote({ session: p2pSession({ workingDirectory: null }) })).toBeTruthy();
  });

  it("keeps loopback unredacted, because that is where it was typed", () => {
    const message = { session: p2pSession() };
    expect(redactForScope(message, "local")).toBe(message);
    expect(JSON.stringify(redactForScope(message, "tunnel"))).not.toContain(PASSPHRASE);
    expect(JSON.stringify(redactForScope(message, "remote"))).not.toContain(PASSPHRASE);
  });

  it("survives a cycle rather than hanging on one", () => {
    const cyclic: any = { session: p2pSession() };
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
      session: { ...current.session, ...p2pSession() } as never,
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
    for (const url of ["/api/bootstrap", `/api/tabs/${tabId}`]) {
      const local = await fetchAs("127.0.0.1:4317", url);
      expect(local.statusCode, url).toBe(200);
      expect(local.body, `${url} on loopback`).toContain(PASSPHRASE);

      const remote = await fetchAs(REMOTE_HOST, url);
      expect(remote.statusCode, url).toBe(200);
      expect(remote.body, `${url} over the tunnel`).not.toContain(PASSPHRASE);
      // Still visible as a tab, so the far end knows encryption is on.
      expect(remote.body, `${url} still names the tab`).toContain(tabId);
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
