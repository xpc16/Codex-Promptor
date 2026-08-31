import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyIndexDelta } from "../shared/index-delta.js";
import type { IndexFile } from "../shared/schemas.js";
import { createApp, parseTerminalSubscriptions, type PromptorApp } from "./app.js";

describe("navigation broadcasts", () => {
  let app: PromptorApp;
  let root: string;
  let address: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-index-broadcast-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    address = await app.listen({ host: "127.0.0.1", port: 0 });
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

  /** A subscribed viewer, plus every index message it receives in order. */
  async function viewer(host?: string) {
    const url = `${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`;
    const socket = new WebSocket(url, host ? { headers: { host } } : undefined);
    sockets.push(socket);
    const received: any[] = [];
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "index.changed") received.push(message);
    });
    await new Promise<void>((resolve, reject) => { socket.on("open", () => resolve()); socket.on("error", reject); });
    socket.send(JSON.stringify({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {} }));
    await waitFor(() => received.length >= 1);
    return { socket, received };
  }

  const waitFor = async (done: () => boolean, timeoutMs = 3_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (done()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("timed out");
  };

  it("sends nothing back to a subscribe that already holds this revision", async () => {
    // Measured on one tunnel: 51 subscribes in 95 minutes, 11.8KB of index
    // each, about three quarters of everything sent that way -- and a
    // subscribe is far more often a tab change or a reconnect than a change
    // anyone made. A page that says what it holds does not need it repeated.
    for (let n = 0; n < 12; n += 1) await app.promptor.storage.createTab(`对话 ${n}`);
    const { socket, received } = await viewer();
    const held = received[0].index as IndexFile;

    socket.send(JSON.stringify({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {}, indexRevision: held.revision }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(received).toHaveLength(1);

    // A page that holds something older still gets the whole index: that is
    // the one encoding which always applies to a viewer that fell behind.
    socket.send(JSON.stringify({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {}, indexRevision: held.revision - 1 }));
    await waitFor(() => received.length >= 2);
    expect(received[1].index).toBeDefined();
  });

  it("replays the whole index on subscribe and only what changed afterwards", async () => {
    // Enough tabs that a delta is worth its own bookkeeping. The measured
    // index this came from carried around forty of them at 13.5KB a broadcast.
    for (let n = 0; n < 12; n += 1) await app.promptor.storage.createTab(`对话 ${n}`);
    const { received } = await viewer();

    // Subscribe is the path a reconnecting page uses precisely because it does
    // not know what it missed, so it must carry the whole index.
    expect(received[0].index).toBeDefined();
    expect(received[0].delta).toBeUndefined();
    const first = received[0].index as IndexFile;

    await app.promptor.storage.createTab("新增");
    await waitFor(() => received.length >= 2);

    // Everything after that is a delta against the revision the viewer holds.
    const second = received[1];
    expect(second.index).toBeUndefined();
    expect(second.delta).toBeDefined();
    expect(second.delta.from).toBe(first.revision);

    const applied = applyIndexDelta(first, second.delta)!;
    expect(applied.tabs).toHaveLength(13);
    expect(applied.tabs.at(-1)!.name).toBe("新增");
    // The whole point: adding one tab must not resend the other.
    expect(second.delta.tabs.upserts).toHaveLength(1);
    expect(JSON.stringify(second).length).toBeLessThan(JSON.stringify(received[0]).length);
  });

  it("never spends more than sending the whole index would have", async () => {
    // A delta is not smaller by definition -- on a very small index its
    // revision, timestamps and two record envelopes can cost more than the
    // tabs they avoid repeating. Whichever branch the server picks, this is
    // the property that has to hold, so it is asserted instead of a branch.
    await app.promptor.storage.createTab("唯一");
    const { received } = await viewer();

    await app.promptor.storage.createTab("第二个");
    await waitFor(() => received.length >= 2);
    const whole = JSON.stringify({ type: "index.changed", index: await app.promptor.storage.readIndex() });
    expect(JSON.stringify(received[1]).length).toBeLessThanOrEqual(whole.length);

    await app.promptor.storage.updateTab((await app.promptor.storage.listTabMeta())[0].id, (current) => ({ ...current, name: "改名" }));
    await waitFor(() => received.length >= 3);
    const afterRename = JSON.stringify({ type: "index.changed", index: await app.promptor.storage.readIndex() });
    expect(JSON.stringify(received[2]).length).toBeLessThanOrEqual(afterRename.length);
  });

  it("keeps two viewers in step even though only one of them is up to date", async () => {
    await app.promptor.storage.createTab("起点");
    const first = await viewer();

    await app.promptor.storage.createTab("第二个");
    await waitFor(() => first.received.length >= 2);

    // This one arrives late and has never seen a revision, so it gets the full
    // index while the other continues on deltas.
    const late = await viewer();
    expect(late.received[0].index).toBeDefined();

    await app.promptor.storage.createTab("第三个");
    await waitFor(() => first.received.length >= 3 && late.received.length >= 2);

    const rebuilt = (messages: any[]): IndexFile => messages.reduce(
      (current: IndexFile | null, message: any) => message.index ? message.index : applyIndexDelta(current!, message.delta),
      null,
    )!;
    expect(rebuilt(first.received).tabs.map((tab) => tab.name)).toEqual(["起点", "第二个", "第三个"]);
    expect(rebuilt(late.received).tabs.map((tab) => tab.name)).toEqual(["起点", "第二个", "第三个"]);
  });

  /** The raw branch of the subscription union, which is the only one with a cursor. */
  const rawCursor = (streams: ReturnType<typeof parseTerminalSubscriptions>) => {
    const stream = streams.get("tab-1");
    return stream && stream.mode === "raw" ? stream.cursor : undefined;
  };

  it("caps what a reconnect off this machine may replay", () => {
    const asked = { "tab-1": { mode: "raw" } };

    // The local page keeps its full scrollback: the bytes cost nothing on a
    // loopback socket, and the buffer is the whole point of raw mode.
    expect(rawCursor(parseTerminalSubscriptions(asked, null))!.maxCatchUpBytes).toBeUndefined();

    // Anything off this machine gets the cap even though it did not ask for
    // one -- and a reconnect, the path that most needs it, never asks.
    expect(rawCursor(parseTerminalSubscriptions(asked, 64 * 1024))!.maxCatchUpBytes).toBe(64 * 1024);

    // A client may ask for less, and may not talk its way past the ceiling.
    expect(rawCursor(parseTerminalSubscriptions({ "tab-1": { mode: "raw", maxCatchUpBytes: 8 * 1024 } }, 64 * 1024))!.maxCatchUpBytes).toBe(8 * 1024);
    expect(rawCursor(parseTerminalSubscriptions({ "tab-1": { mode: "raw", maxCatchUpBytes: 8 * 1024 * 1024 } }, 64 * 1024))!.maxCatchUpBytes).toBe(64 * 1024);
  });
});
