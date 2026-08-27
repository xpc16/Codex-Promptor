import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

// Both ceilings are read once when the module loads, so they are set before the
// import. Scaled down by ~64x from production: what a `thread/read` on a 200MB
// conversation does to the real limits, a few megabytes do to these.
process.env.CODEX_PROMPTOR_CODEX_MAX_FRAME_MB = "8";
process.env.CODEX_PROMPTOR_CODEX_MAX_PARSE_MB = "1";
const { AppServerManager, CodexRpcClient } = await import("./codex.js");

type FakeServer = { url: string; close: () => Promise<void>; requests: string[] };

/** An app server whose `thread/read` and `thread/resume` responses are as big as the test asks for. */
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
      if (message.method === "thread/read" || message.method === "thread/resume") {
        socket.send(JSON.stringify({
          id: message.id,
          result: { thread: { id: message.params.threadId, sessionId: "session-1", turns: [], filler: "x".repeat(responseBytes) } },
        }));
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

describe("responses too large to receive", () => {
  const servers: FakeServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  it("survives one and blames the thread that caused it", async () => {
    const server = await startFakeAppServer(10_000_000);
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
    const server = await startFakeAppServer(10_000_000);
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
});

describe("responses too large to be worth parsing", () => {
  const servers: FakeServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

  it("subscribes to a thread whose resume response carries the whole conversation", async () => {
    const server = await startFakeAppServer(3_000_000);
    servers.push(server);
    const rpc = new CodexRpcClient();
    await rpc.connect(server.url);

    // `thread/resume` is the only way to subscribe and it always answers with
    // the entire thread. Opening a long conversation depends on this call
    // completing without the payload ever becoming objects.
    await expect(rpc.resumeThread("thread-long", "D:\\\\work")).resolves.toBeUndefined();
    expect(rpc.connected).toBe(true);
  });

  it("treats a history read it declined to parse as a thread it cannot read", async () => {
    const server = await startFakeAppServer(3_000_000);
    servers.push(server);
    const rpc = new CodexRpcClient();
    await rpc.connect(server.url);

    // Unparsed is as unusable as unreceived for a call whose whole purpose is
    // the turns, so it settles into the same outcome and the same memo.
    await expect(rpc.readThread("thread-long", 5_000)).rejects.toThrow("CODEX_THREAD_TOO_LARGE:thread-long");
    await expect(rpc.readThread("thread-long", 5_000)).rejects.toThrow("CODEX_THREAD_TOO_LARGE");
    expect(server.requests.filter((method) => method === "thread/read")).toHaveLength(1);
    expect(rpc.connected).toBe(true);
  });

  it("still parses a response under the threshold", async () => {
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
