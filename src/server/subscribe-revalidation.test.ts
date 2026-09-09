import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

/**
 * What a reconnect costs, over a real socket.
 *
 * Measured on the tunnel over 38 minutes: a reconnect every two minutes, each
 * one asking for the whole tab bundle -- 24 kB, a third of everything sent
 * outbound in that window -- and almost always getting back sections the page
 * already had.
 */

describe("a reconnect that missed nothing", () => {
  let app: PromptorApp;
  let root: string;
  let address: string;
  let tabId: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-revalidate-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    tabId = (await app.promptor.storage.createTab("对话")).id;
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

  const connect = async () => {
    const url = `${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`;
    const socket = new WebSocket(url);
    sockets.push(socket);
    const snapshots: any[] = [];
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "snapshot") snapshots.push(message);
    });
    await new Promise<void>((resolve, reject) => { socket.on("open", () => resolve()); socket.on("error", reject); });
    return { socket, snapshots };
  };

  const subscribe = (socket: WebSocket, snapshotTags?: Record<string, unknown>) => socket.send(JSON.stringify({
    type: "subscribe", tabIds: [tabId], index: false, snapshots: true, terminals: {}, ...(snapshotTags ? { snapshotTags } : {}),
  }));

  const settle = async (done: () => boolean, ms = 3_000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 20));
  };

  it("is answered with nothing when the page already holds the bundle", async () => {
    const peer = await connect();
    subscribe(peer.socket);
    await settle(() => peer.snapshots.length >= 1);
    const tags = peer.snapshots[0].snapshotTags;
    expect(typeof tags.runtime).toBe("string");

    subscribe(peer.socket, { [tabId]: tags });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(peer.snapshots, "the 24 kB is not sent again").toHaveLength(1);
  });

  it("sends back only the section that moved", async () => {
    const peer = await connect();
    subscribe(peer.socket);
    await settle(() => peer.snapshots.length >= 1);
    const tags = peer.snapshots[0].snapshotTags;
    expect(Object.keys(tags).sort()).toEqual(["answers", "prompts", "runtime", "tab"]);

    await app.promptor.storage.updateTab(tabId, (current) => ({ ...current, name: "改过名的对话" }));
    subscribe(peer.socket, { [tabId]: tags });
    await settle(() => peer.snapshots.length >= 2);

    const second = peer.snapshots[1];
    expect(second.data.tab.name).toBe("改过名的对话");
    expect(Object.keys(second.data).sort(), "the 24 kB of prompts and answers stays put").toEqual(["tab", "window"]);
    expect(second.snapshotTags.prompts).toBe(tags.prompts);
    expect(second.snapshotTags.tab).not.toBe(tags.tab);
  });

  it("sends the runtime alone when only the runner moved", async () => {
    // The case this exists for: runtime is 2% of a bundle's bytes and the
    // section that moves on almost every event.
    const peer = await connect();
    subscribe(peer.socket);
    await settle(() => peer.snapshots.length >= 1);
    const tags = peer.snapshots[0].snapshotTags;

    await app.promptor.storage.writeRuntime(tabId, {
      ...(await app.promptor.storage.readRuntime(tabId)),
      runner: { ...(await app.promptor.storage.readRuntime(tabId)).runner, desiredState: "running" },
    });
    subscribe(peer.socket, { [tabId]: tags });
    await settle(() => peer.snapshots.length >= 2);
    expect(Object.keys(peer.snapshots[1].data).sort()).toEqual(["runtime", "window"]);
  });

  it("still answers a page that says nothing about what it holds", async () => {
    // The tags are an optimisation, not a protocol requirement: a client that
    // sends none gets the whole bundle, which is what it always got.
    const peer = await connect();
    subscribe(peer.socket);
    await settle(() => peer.snapshots.length >= 1);
    subscribe(peer.socket);
    await settle(() => peer.snapshots.length >= 2);
    expect(Object.keys(peer.snapshots[1].data).sort()).toEqual(["answers", "prompts", "runtime", "tab", "window"]);
  });
});
