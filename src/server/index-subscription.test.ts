import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

/**
 * The index socket wants every conversation's lights, including the ones that
 * do not exist yet. It used to say so by listing every id -- 2.9 KB a time,
 * 60% of the tunnel's inbound bytes -- and had to reconnect whenever the list
 * changed. `allTabs` says the same thing in a few bytes, once.
 */
describe("subscribing to every tab", () => {
  let app: PromptorApp;
  let root: string;
  let address: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-all-tabs-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.on("close", () => resolve());
      socket.close();
      setTimeout(resolve, 200);
    })));
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const open = async (): Promise<{ socket: WebSocket; received: any[] }> => {
    const socket = new WebSocket(`${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`);
    sockets.push(socket);
    const received: any[] = [];
    socket.on("message", (data) => { received.push(JSON.parse(data.toString())); });
    await new Promise<void>((resolve, reject) => { socket.on("open", () => resolve()); socket.on("error", reject); });
    return { socket, received };
  };

  const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

  /** Something the runner would do: a runtime write is what produces `runner.changed`. */
  const nudgeRuntime = async (tabId: string) => {
    const runtime = await app.promptor.storage.readRuntime(tabId);
    runtime.runner = { ...runtime.runner, desiredState: "running" };
    await app.promptor.storage.writeRuntime(tabId, runtime);
  };

  it("hears about a conversation created after it subscribed, without naming it", async () => {
    const { socket, received } = await open();
    const subscribe = JSON.stringify({ type: "subscribe", allTabs: true, index: true, snapshots: false, details: false });
    // The whole point: this does not grow with the number of conversations.
    expect(Buffer.byteLength(subscribe, "utf8")).toBeLessThan(120);
    socket.send(subscribe);
    await settle();

    const later = await app.promptor.storage.createTab("后来才建的");
    await nudgeRuntime(later.id);
    await settle();

    expect(received.some((message) => message.type === "runner.changed" && message.tabId === later.id)).toBe(true);
  });

  it("is only for the socket that also wants the index", async () => {
    // A terminal socket that asked for every tab would receive every
    // conversation's events for nothing; the flag is ignored without `index`.
    const { socket, received } = await open();
    socket.send(JSON.stringify({ type: "subscribe", allTabs: true, snapshots: false, details: false }));
    await settle();

    const tab = await app.promptor.storage.createTab("终端");
    await nudgeRuntime(tab.id);
    await settle();

    expect(received.some((message) => message.type === "runner.changed")).toBe(false);
  });

  it("still honours an explicit list, which is what older pages send", async () => {
    const listed = await app.promptor.storage.createTab("列出的");
    const other = await app.promptor.storage.createTab("没列出的");
    const { socket, received } = await open();
    socket.send(JSON.stringify({ type: "subscribe", tabIds: [listed.id], index: true, snapshots: false, details: false }));
    await settle();

    await nudgeRuntime(listed.id);
    await nudgeRuntime(other.id);
    await settle();

    const runnerEvents = received.filter((message) => message.type === "runner.changed").map((message) => message.tabId);
    expect(runnerEvents).toContain(listed.id);
    expect(runnerEvents).not.toContain(other.id);
  });
});
