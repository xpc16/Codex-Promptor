import { EventEmitter } from "node:events";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { TuiThreadRequestTracker, type TuiThreadSelection } from "./tui-protocol.js";

export type TuiProxyCallbacks = {
  onThreadSelection: (selection: TuiThreadSelection) => Promise<void> | void;
  onError: (error: Error) => void;
};

type ProxyEntry = {
  server: WebSocketServer;
  url: string;
};

/** A loopback-only, per-tab WebSocket proxy accepted by Codex CLI --remote. */
export class TuiProxyPool extends EventEmitter {
  private readonly entries = new Map<string, ProxyEntry>();

  async start(tabId: string, upstreamUrl: string, callbacks: TuiProxyCallbacks): Promise<string> {
    await this.stop(tabId);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    try {
      await waitForListening(server);
    } catch (error) {
      server.close();
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("CODEX_TUI_PROXY_ADDRESS_MISSING");
    }
    const url = `ws://127.0.0.1:${address.port}`;
    const entry: ProxyEntry = { server, url };
    this.entries.set(tabId, entry);
    server.on("connection", (socket) => bridgeCodexRemote(socket, upstreamUrl, callbacks));
    server.on("error", (error) => callbacks.onError(error));
    return url;
  }

  url(tabId: string): string | null { return this.entries.get(tabId)?.url ?? null; }

  async stop(tabId: string): Promise<void> {
    const entry = this.entries.get(tabId);
    if (!entry) return;
    this.entries.delete(tabId);
    for (const client of entry.server.clients) {
      try { client.close(1001, "Codex Promptor terminal closed"); } catch { /* already closed */ }
    }
    await closeServer(entry.server);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((tabId) => this.stop(tabId)));
  }
}

export function bridgeCodexRemote(downstream: WebSocket, upstreamUrl: string, callbacks: TuiProxyCallbacks): void {
  const upstream = new WebSocket(upstreamUrl);
  const tracker = new TuiThreadRequestTracker();
  const queued: Array<{ data: Buffer; isBinary: boolean }> = [];
  let queuedBytes = 0;
  let closing = false;

  const reportError = (reason: unknown) => callbacks.onError(reason instanceof Error ? reason : new Error(String(reason)));
  const closeBoth = (code = 1011, reason = "Codex bridge closed") => {
    if (closing) return;
    closing = true;
    tracker.clear();
    try { if (downstream.readyState === WebSocket.OPEN || downstream.readyState === WebSocket.CONNECTING) downstream.close(code, reason); } catch { /* already closed */ }
    try { if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason); } catch { /* already closed */ }
  };

  downstream.on("message", (data: RawData, isBinary: boolean) => {
    const received = rawDataBuffer(data);
    const frame = isBinary ? received : Buffer.from(normalizeTuiClientMessage(received.toString("utf8")), "utf8");
    if (!isBinary) tracker.observeClientMessage(frame.toString("utf8"));
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(frame, { binary: isBinary });
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    queuedBytes += frame.length;
    if (queued.length >= 256 || queuedBytes > 2_000_000) {
      reportError(new Error("CODEX_REMOTE_BRIDGE_BUFFER_LIMIT"));
      closeBoth(1009, "Codex bridge buffer limit exceeded");
      return;
    }
    queued.push({ data: frame, isBinary });
  });

  upstream.once("open", () => {
    for (const frame of queued) upstream.send(frame.data, { binary: frame.isBinary });
    queued.length = 0;
    queuedBytes = 0;
  });
  upstream.on("message", (data: RawData, isBinary: boolean) => {
    const frame = rawDataBuffer(data);
    if (downstream.readyState === WebSocket.OPEN) downstream.send(frame, { binary: isBinary });
    if (isBinary) return;
    const selection = tracker.observeServerMessage(frame.toString("utf8"));
    if (selection) Promise.resolve(callbacks.onThreadSelection(selection)).catch(reportError);
  });
  upstream.on("error", (error) => {
    if (!closing) reportError(error);
    closeBoth(1011, "Codex App Server connection failed");
  });
  downstream.on("error", (error) => {
    if (!closing) reportError(error);
    closeBoth();
  });
  upstream.on("close", (code, reason) => closeBoth(normalizeWebSocketCloseCode(code), reason.toString() || "Codex App Server closed"));
  downstream.on("close", (code, reason) => closeBoth(normalizeWebSocketCloseCode(code), reason.toString() || "Codex TUI closed"));
}

/**
 * Codex TUI currently requests paginated history for fresh remote threads.
 * Promptor needs full thread/read history for JSON reconciliation, while the
 * App Server rejects full-history reads for paginated rollouts. Keep the TUI
 * transport transparent except for selecting the documented legacy mode on
 * thread/start so both clients can use the same persisted conversation.
 */
export function normalizeTuiClientMessage(raw: string): string {
  try {
    const message = JSON.parse(raw);
    if (!message || typeof message !== "object" || Array.isArray(message) || message.method !== "thread/start") return raw;
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params
      : {};
    if (params.historyMode !== "paginated") return raw;
    return JSON.stringify({ ...message, params: { ...params, historyMode: "legacy" } });
  } catch {
    return raw;
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function normalizeWebSocketCloseCode(code: number): number {
  return code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code) ? code : 1011;
}

function waitForListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => { cleanup(); resolve(); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => {
      server.removeListener("listening", onListening);
      server.removeListener("error", onError);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    if (server.clients.size === 0) {
      server.close(() => resolve());
      return;
    }
    const timer = setTimeout(() => {
      for (const client of server.clients) client.terminate();
    }, 1_000);
    server.close(() => { clearTimeout(timer); resolve(); });
  });
}
