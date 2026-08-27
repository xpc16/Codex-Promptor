import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

describe("traffic recording", () => {
  let app: PromptorApp;
  let root: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-traffic-record-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
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

  const get = (url: string, headers: Record<string, string> = {}) => app.inject({
    method: "GET",
    url,
    headers: { "x-codex-promptor-token": app.promptor.token, ...headers },
  });

  const traffic = async (): Promise<any> => (await get("/api/diagnostics/traffic")).json().data;

  it("records an API response by route, method and status", async () => {
    await app.ready();
    const tab = await app.promptor.storage.createTab("流量");
    await get(`/api/tabs/${tab.id}`);

    const { rollup } = await traffic();
    const entry = rollup.entries["out:http:GET /api/tabs/:tabId 200"];
    expect(entry).toBeDefined();
    // The route pattern, not the concrete tab id -- otherwise the key space
    // grows with the conversation count and the report becomes unreadable.
    expect(Object.keys(rollup.entries).some((key) => key.includes(tab.id))).toBe(false);
    expect(entry.count).toBe(1);
    expect(entry.bytes).toBeGreaterThan(0);
  });

  it("separates a 304 from a 200 so the cache saving is measurable", async () => {
    await app.ready();
    const tab = await app.promptor.storage.createTab("缓存");
    const etag = (await get(`/api/tabs/${tab.id}`)).headers.etag as string;
    await get(`/api/tabs/${tab.id}`, { "if-none-match": etag });

    const { rollup } = await traffic();
    const full = rollup.entries["out:http:GET /api/tabs/:tabId 200"];
    const revalidated = rollup.entries["out:http:GET /api/tabs/:tabId 304"];
    expect(full.count).toBe(1);
    expect(revalidated.count).toBe(1);
    // This difference is the whole point of the exercise. A 304 is not free --
    // it still costs its headers -- so the number has to be above zero and
    // well below the full body.
    expect(revalidated.bytes).toBeGreaterThan(0);
    expect(revalidated.bytes).toBeLessThan(full.bytes);
  });

  it("records the size before compression alongside the size on the wire", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const tab = await app.promptor.storage.createTab("压缩");
    // Enough repetitive text that compression is worth doing and clears the
    // plugin's 512-byte threshold.
    const prompts = await app.promptor.storage.readTab(tab.id).then((bundle) => bundle.prompts);
    prompts.prompts = Array.from({ length: 40 }, (_unused, index) => ({
      id: `p${index}`, text: "重复的内容 ".repeat(20), status: "pending" as const,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      origin: "queue" as const, threadId: null, startedAt: null, completedAt: null,
      codexTurnId: null, clientUserMessageId: null, attempts: [], error: null,
    }));
    await app.promptor.storage.writePrompts(tab.id, prompts);

    // A real socket, because the compressed bytes only exist on one: the
    // wire size is measured from the socket, not from the payload.
    const response = await fetch(`${address}/api/tabs/${tab.id}`, {
      headers: { "x-codex-promptor-token": app.promptor.token, "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    await response.arrayBuffer();

    const { rollup } = await traffic();
    const entry = rollup.entries["out:http:GET /api/tabs/:tabId 200"];
    expect(entry.rawBytes).toBeGreaterThan(entry.bytes);
  });

  it("records WebSocket messages in both directions, by message type", async () => {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const url = `${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`;
    const tab = await app.promptor.storage.createTab("套接字");

    const socket = new WebSocket(url);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("error", reject);
    });
    socket.send(JSON.stringify({ type: "subscribe", tabIds: [tab.id], index: true, snapshots: false }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const { rollup } = await traffic();
    expect(rollup.entries["in:ws:subscribe"]).toMatchObject({ count: 1 });
    expect(rollup.entries["in:ws:subscribe"].bytes).toBeGreaterThan(0);
    // Subscribing with index:true replays navigation, which is an outbound
    // message this ledger must see.
    expect(rollup.entries["out:ws:index.changed"]).toMatchObject({ count: 1 });
  });

  it("reports rates and keeps the newest kinds first", async () => {
    await app.ready();
    const tab = await app.promptor.storage.createTab("速率");
    for (let index = 0; index < 3; index += 1) await get(`/api/tabs/${tab.id}`);

    const { rollup, window } = await traffic();
    expect(window.hours).toBe(24);
    expect(rollup.totals.count).toBeGreaterThanOrEqual(3);
    const first = Object.values(rollup.entries)[0] as any;
    const last = Object.values(rollup.entries).at(-1) as any;
    expect(first.bytes).toBeGreaterThanOrEqual(last.bytes);
    expect(first.bytesPerSecond).toBeGreaterThan(0);
  });

  it("clears on request", async () => {
    await app.ready();
    const tab = await app.promptor.storage.createTab("清空");
    await get(`/api/tabs/${tab.id}`);

    await app.inject({
      method: "POST",
      url: "/api/diagnostics/traffic/reset",
      headers: { "x-codex-promptor-token": app.promptor.token },
      payload: {},
    });

    // The reset response itself is recorded, so the conversation read is gone
    // but the count is not necessarily zero.
    const { rollup } = await traffic();
    expect(rollup.entries["out:http:GET /api/tabs/:tabId 200"]).toBeUndefined();
  });
});
