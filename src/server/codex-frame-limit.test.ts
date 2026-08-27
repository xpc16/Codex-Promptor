import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

// The frame ceiling is read once when the module loads, so it is set before the
// import. 1MB keeps the oversized response in this test small; in production the
// same path is reached by a `thread/read` on a conversation whose rollout has
// grown past 100MB.
process.env.CODEX_PROMPTOR_CODEX_MAX_FRAME_MB = "1";
const { AppServerManager, CodexRpcClient } = await import("./codex.js");

type FakeServer = { url: string; close: () => Promise<void>; requests: string[] };

/** An app server that answers `initialize` normally and `thread/read` with an oversized response. */
async function startFakeAppServer(responseBytes: number): Promise<FakeServer> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const requests: string[] = [];
  const sockets = new Set<ServerSocket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("message", (raw: Buffer) => {
      const message = JSON.parse(raw.toString());
      if (!message.method) return;
      requests.push(message.method);
      if (message.id === undefined) return;
      if (message.method === "thread/read") {
        socket.send(JSON.stringify({ id: message.id, result: { thread: { id: message.params.threadId, turns: [], filler: "x".repeat(responseBytes) } } }));
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}`,
    requests,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("oversized app-server responses", () => {
  const servers: FakeServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  it("survives a response too large to receive and blames the thread that caused it", async () => {
    const server = await startFakeAppServer(1_500_000);
    servers.push(server);
    const rpc = new CodexRpcClient();
    await rpc.connect(server.url);

    // Before this fix the socket error reached an EventEmitter with no `error`
    // listener, which ends the process rather than the request. Reaching the
    // assertion at all is most of what this test checks.
    await expect(rpc.readThread("thread-huge", 5_000)).rejects.toThrow("CODEX_THREAD_TOO_LARGE:thread-huge");
    expect(rpc.connected).toBe(false);
  });

  it("refuses a thread already known to be unreadable instead of killing another socket", async () => {
    const server = await startFakeAppServer(1_500_000);
    servers.push(server);
    const rpc = new CodexRpcClient();
    await rpc.connect(server.url);
    await expect(rpc.readThread("thread-huge", 5_000)).rejects.toThrow("CODEX_THREAD_TOO_LARGE");

    await rpc.connect(server.url);
    await expect(rpc.readThread("thread-huge", 5_000)).rejects.toThrow("CODEX_THREAD_TOO_LARGE");
    // The second attempt never reached the wire, so the reconnected socket is
    // still usable for everything else this thread needs.
    expect(server.requests.filter((method) => method === "thread/read")).toHaveLength(1);
    expect(rpc.connected).toBe(true);
  });

  it("keeps ordinary responses working under the same ceiling", async () => {
    const server = await startFakeAppServer(1_000);
    servers.push(server);
    const rpc = new CodexRpcClient();
    await rpc.connect(server.url);

    await expect(rpc.readThread("thread-small", 5_000)).resolves.toMatchObject({ thread: { id: "thread-small" } });
    expect(rpc.connected).toBe(true);
  });
});

describe("app server reachability", () => {
  it("stops reporting ready once the RPC socket is gone", async () => {
    const manager = new AppServerManager();
    (manager as any)._status = { state: "ready", url: "ws://127.0.0.1:1", error: null };

    manager.rpc.emit("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // "ready" with a dead socket is the state that made every later call fail
    // against nothing and never recover.
    expect(manager.status.state).toBe("error");
    expect(manager.status.error).toBe("CODEX_APP_SERVER_DISCONNECTED");
  });

  it("leaves a deliberate shutdown alone", async () => {
    const manager = new AppServerManager();
    (manager as any)._status = { state: "ready", url: "ws://127.0.0.1:1", error: null };
    (manager as any).intentionalStop = true;

    manager.rpc.emit("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.status.state).toBe("ready");
  });
});
