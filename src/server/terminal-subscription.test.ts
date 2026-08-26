import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

describe("terminal WebSocket subscription isolation", () => {
  let app: PromptorApp;
  let root: string;
  let url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-terminal-ws-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    url = address.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(app.promptor.token)}`;
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map(closeSocket));
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps raw PTY bytes off the global state connection", async () => {
    const tab = await app.promptor.storage.createTab("isolation");
    const stateSocket = await connect(url, sockets);
    const messages = collect(stateSocket);
    stateSocket.send(JSON.stringify({ type: "subscribe", tabIds: [tab.id], snapshots: false, index: false }));
    await delay(25);

    app.promptor.pty.emit("event", rawEvent(tab.id, 0, "secret terminal output"));
    await delay(80);
    expect(messages.some((message) => message.type === "terminal.output")).toBe(false);

    app.promptor.pty.emit("event", { tabId: tab.id, type: "state", state: "running" });
    await eventually(() => messages.some((message) => message.type === "terminal.state"));
  });

  it("sends one terminal snapshot, no duplicate TabBundle, then batches adjacent output", async () => {
    const tab = await app.promptor.storage.createTab("terminal");
    vi.spyOn(app.promptor.pty, "snapshot").mockReturnValue({
      generation: "generation-1",
      startOffset: 0,
      endOffset: 4,
      reset: true,
      dataBase64: Buffer.from("base", "utf8").toString("base64"),
    });
    const socket = await connect(url, sockets);
    const messages = collect(socket);
    socket.send(JSON.stringify({
      type: "subscribe",
      tabIds: [tab.id],
      snapshots: false,
      terminals: { [tab.id]: { mode: "raw", generation: null, nextOffset: null } },
    }));

    await eventually(() => messages.filter((message) => message.type === "terminal.output").length === 1);
    expect(messages.some((message) => message.type === "snapshot")).toBe(false);
    const first = messages.find((message) => message.type === "terminal.output");
    expect(first).toMatchObject({ reset: true, sequence: 1 });
    expect(first.streamId).toEqual(expect.any(String));

    app.promptor.pty.emit("event", rawEvent(tab.id, 4, "one"));
    app.promptor.pty.emit("event", rawEvent(tab.id, 7, "two"));
    await eventually(() => messages.filter((message) => message.type === "terminal.output").length === 2);
    const second = messages.filter((message) => message.type === "terminal.output")[1];
    expect(second).toMatchObject({ reset: false, startOffset: 4, endOffset: 10, sequence: 2, streamId: first.streamId });
    expect(Buffer.from(second.dataBase64, "base64").toString("utf8")).toBe("onetwo");
  });

  it("requires a terminal subscription before input and exposes content-free metrics", async () => {
    const tab = await app.promptor.storage.createTab("input");
    const write = vi.spyOn(app.promptor.pty, "write");
    const stateSocket = await connect(url, sockets);
    const stateMessages = collect(stateSocket);
    stateSocket.send(JSON.stringify({ type: "subscribe", tabIds: [tab.id], snapshots: false }));
    stateSocket.send(JSON.stringify({ type: "terminal.input", tabId: tab.id, dataBase64: Buffer.from("blocked").toString("base64") }));
    await eventually(() => stateMessages.some((message) => message.error?.code === "TERMINAL_NOT_SUBSCRIBED"));
    expect(write).not.toHaveBeenCalled();

    const terminalSocket = await connect(url, sockets);
    const terminalMessages = collect(terminalSocket);
    terminalSocket.send(JSON.stringify({ type: "subscribe", tabIds: [tab.id], snapshots: false, terminals: { [tab.id]: { mode: "raw" } } }));
    terminalSocket.send(JSON.stringify({ type: "terminal.input", tabId: tab.id, inputId: "input-1", dataBase64: Buffer.from("allowed").toString("base64") }));
    await eventually(() => terminalMessages.some((message) => message.type === "terminal.input.ack"));
    expect(write).toHaveBeenCalledWith(tab.id, "allowed");

    const response = await app.inject({
      method: "GET",
      url: "/api/diagnostics/terminal-traffic",
      headers: { "x-codex-promptor-token": app.promptor.token },
    });
    expect(response.statusCode).toBe(200);
    const metrics = response.json().data;
    expect(metrics.totals.messages).toBeGreaterThan(0);
    expect(JSON.stringify(metrics)).not.toContain("allowed");
    expect(JSON.stringify(metrics)).not.toContain("blocked");
  });
});

function rawEvent(tabId: string, startOffset: number, text: string) {
  const data = Buffer.from(text, "utf8");
  return {
    tabId,
    type: "output",
    generation: "generation-1",
    startOffset,
    endOffset: startOffset + data.length,
    dataBase64: data.toString("base64"),
  };
}

async function connect(url: string, sockets: WebSocket[]): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function collect(socket: WebSocket): any[] {
  const messages: any[] = [];
  socket.on("message", (raw) => {
    try { messages.push(JSON.parse(raw.toString())); } catch { /* test ignores malformed data */ }
  });
  return messages;
}

function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
    setTimeout(resolve, 250).unref?.();
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function eventually(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for WebSocket message");
    await delay(10);
  }
}
