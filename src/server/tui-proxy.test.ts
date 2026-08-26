import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { TuiProxyPool } from "./tui-proxy.js";

describe("Codex TUI loopback proxy", () => {
  it("uses a CLI-compatible host:port URL and forwards thread selection unchanged", async () => {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await listening(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream address missing");
    const onSelection = vi.fn();
    const onContextCompacted = vi.fn();
    upstream.on("connection", (socket) => socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ id: request.id, result: { thread: { id: request.params.threadId, cwd: request.params.cwd } } }));
      socket.send(JSON.stringify({ method: "item/completed", params: { threadId: request.params.threadId, turnId: "turn-compact", item: { type: "contextCompaction", id: "compact-1" } } }));
    }));

    const pool = new TuiProxyPool();
    const proxyUrl = await pool.start("tab-1", `ws://127.0.0.1:${address.port}`, { onThreadSelection: onSelection, onContextCompacted, onError: vi.fn() });
    expect(proxyUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    const client = new WebSocket(proxyUrl);
    try {
      await opened(client);
      client.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread-b", cwd: "D:\\live" } }));
      await eventually(() => onSelection.mock.calls.length === 1);
      await eventually(() => onContextCompacted.mock.calls.length === 1);
      expect(onSelection).toHaveBeenCalledWith(expect.objectContaining({
        method: "thread/resume",
        requestedThreadId: "thread-b",
        requestedCwd: "D:\\live",
        thread: expect.objectContaining({ id: "thread-b" }),
      }));
      expect(onContextCompacted).toHaveBeenCalledWith({ threadId: "thread-b", turnId: "turn-compact" });
    } finally {
      client.close();
      await pool.stopAll();
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  it("uses legacy history for new TUI threads so full history remains readable", async () => {
    const upstream = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await listening(upstream);
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("upstream address missing");
    const received: any[] = [];
    upstream.on("connection", (socket) => socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      received.push(request);
      socket.send(JSON.stringify({ id: request.id, result: { thread: { id: "thread-new" } } }));
    }));

    const pool = new TuiProxyPool();
    const proxyUrl = await pool.start("tab-new", `ws://127.0.0.1:${address.port}`, { onThreadSelection: vi.fn(), onError: vi.fn() });
    const client = new WebSocket(proxyUrl);
    try {
      await opened(client);
      client.send(JSON.stringify({ id: 2, method: "thread/start", params: { cwd: "D:\\work", historyMode: "paginated" } }));
      await eventually(() => received.length === 1);
      expect(received[0]).toMatchObject({
        method: "thread/start",
        params: { cwd: "D:\\work", historyMode: "legacy" },
      });
    } finally {
      client.close();
      await pool.stopAll();
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

function listening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
