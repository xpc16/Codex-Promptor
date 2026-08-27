import { EventEmitter } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import WebSocket from "ws";
import type { AppServerOwnership } from "../shared/schemas.js";
import { readCodexRolloutThread } from "./codex-history.js";

const execFileAsync = promisify(execFile);

export type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code?: number; message?: string; data?: unknown };
};

export type TurnCompletedEvent = {
  threadId: string;
  turnId: string;
  turn: any;
  items: any[];
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type TurnAccumulator = {
  threadId: string;
  turnId: string;
  turn: any;
  items: any[];
  startedAt: string | null;
};

const THREAD_SUMMARY_POLL_MS = 5_000;

/**
 * Ceiling for a single app-server frame.
 *
 * Some responses are unavoidably enormous. `thread/resume` is the only way to
 * subscribe to a thread and it returns the entire conversation every time --
 * measured at 101MB for a 202MB rollout, whether the thread was cold or
 * already loaded -- so a limit that rejects it makes the conversation
 * impossible to open. What keeps that affordable is not receiving less but
 * refusing to build objects out of it; see MAX_PARSED_RESPONSE_BYTES.
 * `ws` would otherwise apply its own 100MB and tear the connection down with
 * an unattributed RangeError. Override with CODEX_PROMPTOR_CODEX_MAX_FRAME_MB.
 */
const MAX_RPC_FRAME_MB = boundedMegabytes(process.env.CODEX_PROMPTOR_CODEX_MAX_FRAME_MB, 512);

/**
 * Above this, a response is acknowledged without being parsed.
 *
 * Every caller of `thread/resume` wants the subscription, not the payload, and
 * the one field ever read from it -- `sessionId` -- is in the 2.7KB summary as
 * well. Turning 101MB of JSON into objects costs several times its size in
 * memory to produce a value nobody looks at.
 */
const MAX_PARSED_RESPONSE_BYTES = boundedMegabytes(process.env.CODEX_PROMPTOR_CODEX_MAX_PARSE_MB, 4) * 1024 * 1024;

/** How far into a frame the JSON-RPC id is looked for before giving up and parsing normally. */
const RESPONSE_ID_PREFIX_BYTES = 256;

/**
 * `thread/resume` loads and replays the whole rollout: 6-10s for a 202MB thread
 * on an idle server, and it runs while the TUI is loading the same thread. The
 * ordinary 30s request timeout turns that into a failed open.
 */
const RESUME_TIMEOUT_MS = 180_000;

/** The `ws` error code for a frame that declares more bytes than `maxPayload` allows. */
const WS_OVERSIZED_FRAME = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";

/** Stands in for a response too large to be worth parsing. */
export type OversizedResponse = { oversizedBytes: number };

export function isOversizedResponse(value: unknown): value is OversizedResponse {
  return typeof (value as OversizedResponse | null)?.oversizedBytes === "number";
}

function boundedMegabytes(raw: string | undefined, fallback: number): number {
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes)) return fallback;
  return Math.min(1_024, Math.max(1, Math.trunc(megabytes)));
}

/**
 * The JSON-RPC id from the head of a frame, without parsing the rest of it.
 * A guess that does not match a pending request is discarded by the caller, so
 * the worst case is the parse that would have happened anyway.
 */
function peekResponseId(raw: Buffer): number | string | null {
  const head = raw.subarray(0, RESPONSE_ID_PREFIX_BYTES).toString("latin1");
  const match = /"id"\s*:\s*(\d+|"([^"\\]*)")/.exec(head);
  if (!match) return null;
  return match[2] !== undefined ? match[2] : Number(match[1]);
}

export class CodexRpcClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly turns = new Map<string, TurnAccumulator>();
  private readonly completed = new Map<string, TurnCompletedEvent>();
  private readonly activeThreads = new Set<string>();
  private connectPromise: Promise<void> | null = null;
  /**
   * Threads whose history does not fit in a frame. Asking again would only
   * kill the connection again, so the full read is abandoned for the rest of
   * this process and the turn is carried by streamed items instead.
   */
  private readonly oversizedThreads = new Set<string>();
  /** When the socket last died of an oversized frame, so the read that caused it can be identified. */
  private overflowedAt = 0;

  constructor() {
    super();
    // EventEmitter turns an unobserved `error` event into a thrown exception.
    // A failed upstream socket has to fail the calls that depend on it, not
    // stop a service that is also hosting terminals for other providers.
    this.on("error", () => undefined);
  }

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  async connect(url: string): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { maxPayload: MAX_RPC_FRAME_MB * 1024 * 1024 });
      this.socket = socket;
      let settled = false;
      // An oversized frame is a connection-level failure in the WebSocket
      // protocol rather than a failed request, so the only way to blame the
      // request that caused it is to note when it happened.
      const noteOverflow = (error: Error) => {
        if ((error as { code?: string }).code === WS_OVERSIZED_FRAME) this.overflowedAt = Date.now();
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = null;
        try { socket.close(); } catch { /* socket may not have opened */ }
        reject(error);
      };
      const onSocketError = (error: Error) => {
        noteOverflow(error);
        if (!settled) fail(error);
        else this.emit("error", error);
      };
      socket.once("error", onSocketError);
      socket.once("open", async () => {
        try {
          await this.request("initialize", {
            clientInfo: { name: "codex-promptor", version: "0.1.0" },
          }, 5_000);
          this.notify("initialized", {});
          settled = true;
          socket.removeListener("error", onSocketError);
          socket.on("error", (error) => { noteOverflow(error); this.emit("error", error); });
          resolve();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("message", (data) => this.handleMessage(toBuffer(data)));
      socket.once("close", () => {
        if (!settled) fail(new Error("CODEX_APP_SERVER_DISCONNECTED"));
        if (this.socket !== socket) return;
        this.socket = null;
        for (const [id, request] of this.pending) {
          clearTimeout(request.timer);
          request.reject(new Error("CODEX_APP_SERVER_DISCONNECTED"));
          this.pending.delete(id);
        }
        this.emit("disconnected");
      });
    });
    try { await this.connectPromise; } finally { this.connectPromise = null; }
  }

  private handleMessage(raw: Buffer): void {
    if (raw.length > MAX_PARSED_RESPONSE_BYTES && this.settleWithoutParsing(raw)) return;
    let message: RpcMessage;
    try { message = JSON.parse(raw.toString()) as RpcMessage; } catch { return; }
    if (message.id !== undefined && (Object.prototype.hasOwnProperty.call(message, "result") || Object.prototype.hasOwnProperty.call(message, "error"))) {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${message.error.code ?? "RPC_ERROR"}: ${message.error.message ?? "request failed"}`));
      else request.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.emit("serverRequest", { id: message.id, method: message.method, params: message.params ?? {} });
      return;
    }
    if (message.method) this.handleNotification(message.method, message.params ?? {});
  }

  /**
   * Complete a pending request from an oversized frame using only its head.
   * Returns false when the id cannot be read or does not belong to a request
   * still waiting, in which case the frame is parsed as usual rather than lost.
   */
  private settleWithoutParsing(raw: Buffer): boolean {
    const id = peekResponseId(raw);
    if (id === null) return false;
    const request = this.pending.get(id);
    if (!request) return false;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.resolve({ oversizedBytes: raw.length } satisfies OversizedResponse);
    return true;
  }

  private handleNotification(method: string, params: any): void {
    this.emit("notification", { method, params });
    if (method === "turn/started") {
      const turn = params.turn ?? params;
      const threadId = String(params.threadId ?? turn.threadId ?? "");
      const turnId = String(params.turnId ?? turn.id ?? "");
      if (!threadId || !turnId) return;
      this.activeThreads.add(threadId);
      this.turns.set(turnId, { threadId, turnId, turn, items: [], startedAt: turn.startedAt ?? null });
      this.emit("turnStarted", { threadId, turnId, turn });
    } else if (method === "item/completed" || method === "item/started") {
      const item = params.item ?? params;
      const turnId = String(params.turnId ?? item.turnId ?? "");
      const accumulator = this.turns.get(turnId);
      if (accumulator && method === "item/completed") accumulator.items.push(item);
      this.emit(method === "item/completed" ? "itemCompleted" : "itemStarted", { ...params, item, turnId });
      if (method === "item/completed" && String(item?.type ?? "").replace(/[_-]/g, "").toLowerCase() === "contextcompaction") {
        this.emit("threadCompacted", {
          threadId: String(params.threadId ?? item.threadId ?? accumulator?.threadId ?? ""),
          turnId,
          item,
        });
      }
    } else if (method === "turn/completed") {
      const turn = params.turn ?? params;
      const threadId = String(params.threadId ?? turn.threadId ?? "");
      const turnId = String(params.turnId ?? turn.id ?? "");
      const accumulator = this.turns.get(turnId) ?? { threadId, turnId, turn, items: [], startedAt: turn.startedAt ?? null };
      accumulator.turn = turn;
      if (Array.isArray(turn.items)) accumulator.items = turn.items;
      const event: TurnCompletedEvent = { threadId: accumulator.threadId, turnId, turn, items: accumulator.items };
      this.rememberCompletedTurn(event);
    } else if (method === "thread/compacted") {
      this.emit("threadCompacted", {
        threadId: String(params.threadId ?? ""),
        turnId: String(params.turnId ?? ""),
        item: null,
      });
    }
  }

  private send(message: RpcMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("CODEX_APP_SERVER_NOT_CONNECTED");
    this.socket.send(JSON.stringify(message));
  }

  notify(method: string, params: unknown): void { this.send({ method, params }); }

  respond(id: number | string, result: unknown): void { this.send({ id, result }); }

  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async startThread(cwd: string): Promise<any> {
    return this.request("thread/start", { cwd, serviceName: "codex-promptor" });
  }

  async readThread(threadId: string, timeoutMs = 30_000): Promise<any> {
    if (this.oversizedThreads.has(threadId)) throw new Error(`CODEX_THREAD_TOO_LARGE:${threadId}`);
    const startedAt = Date.now();
    try {
      const result = await this.request("thread/read", { threadId, includeTurns: true }, timeoutMs);
      if (isOversizedResponse(result)) {
        this.oversizedThreads.add(threadId);
        throw new Error(`CODEX_THREAD_TOO_LARGE:${threadId}`);
      }
      return result;
    } catch (error) {
      // The frame limit closes the socket instead of failing one request, so
      // this read comes back as a disconnect. Recognising it here is what
      // stops the next poll from asking for the same oversized history.
      if (this.overflowedAt >= startedAt) {
        this.oversizedThreads.add(threadId);
        throw new Error(`CODEX_THREAD_TOO_LARGE:${threadId}`);
      }
      throw error;
    }
  }

  async readThreadSummary(threadId: string, timeoutMs = 30_000): Promise<any> {
    return this.request("thread/read", { threadId, includeTurns: false }, timeoutMs);
  }

  /**
   * Join a thread so this connection receives its notifications. There is no
   * lighter call for it -- the protocol has no `thread/subscribe` -- and the
   * response carries the whole conversation, which no caller reads.
   */
  async resumeThread(threadId: string, cwd: string): Promise<void> {
    await this.request("thread/resume", { threadId, cwd }, RESUME_TIMEOUT_MS);
  }

  async loadedThreadIds(timeoutMs = 2_000): Promise<string[]> {
    const result = await this.request("thread/loaded/list", { limit: 1_000 }, timeoutMs);
    return Array.isArray(result?.data) ? result.data.map(String).filter(Boolean) : [];
  }

  async unsubscribeThread(threadId: string, timeoutMs = 2_000): Promise<any> {
    return this.request("thread/unsubscribe", { threadId }, timeoutMs);
  }

  async releaseLoadedThreads(timeoutMs = 2_000): Promise<void> {
    if (!this.connected) return;
    const threadIds = await this.loadedThreadIds(timeoutMs);
    await Promise.all(threadIds.map((threadId) => this.unsubscribeThread(threadId, timeoutMs).catch(() => undefined)));
  }

  async interruptTurn(threadId: string, turnId: string): Promise<any> {
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async steerTurn(threadId: string, expectedTurnId: string, text: string, clientUserMessageId: string): Promise<any> {
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      clientUserMessageId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async startTurn(threadId: string, text: string, clientUserMessageId: string, cwd: string): Promise<{ turnId: string; raw: any }> {
    const raw = await this.request("turn/start", {
      threadId,
      clientUserMessageId,
      cwd,
      input: [{ type: "text", text, text_elements: [] }],
    });
    const turn = raw?.turn ?? raw;
    const turnId = String(raw?.turnId ?? turn?.id ?? "");
    if (!turnId) throw new Error("TURN_ID_MISSING");
    this.activeThreads.add(threadId);
    if (!this.turns.has(turnId)) this.turns.set(turnId, { threadId, turnId, turn, items: [], startedAt: turn?.startedAt ?? null });
    return { turnId, raw };
  }

  async waitForTurn(turnId: string, timeoutMs = 24 * 60 * 60 * 1000, pollMs = THREAD_SUMMARY_POLL_MS): Promise<TurnCompletedEvent> {
    const deadline = Date.now() + timeoutMs;
    let lastSettledSummaryKey: string | null = null;
    while (Date.now() < deadline) {
      const already = this.completed.get(turnId);
      if (already) return already;

      // Codex may route completion notifications to the interactive TUI client
      // instead of this controller connection. Keep notifications as the
      // immediate path, but use the inexpensive summary as a low-frequency
      // fallback. A potentially very large turn history is read only once for
      // each distinct settled summary state.
      const signaled = await this.waitForTurnNotification(turnId, Math.min(Math.max(0, pollMs), Math.max(0, deadline - Date.now())));
      if (signaled) return signaled;

      const accumulator = this.turns.get(turnId);
      if (!accumulator?.threadId) continue;
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const summaryResponse = await this.readThreadSummary(accumulator.threadId, Math.min(30_000, remaining));
        const summary = unwrapThread(summaryResponse);
        if (!threadSettled(summary)) {
          lastSettledSummaryKey = null;
          continue;
        }
        const summaryKey = settledSummaryKey(summary);
        if (summaryKey === lastSettledSummaryKey) continue;

        // Recorded before the read rather than after it: a read that fails --
        // above all one that fails by closing the connection -- must not be
        // repeated on every poll until the thread reaches a new settled state.
        lastSettledSummaryKey = summaryKey;
        const thread = await this.readSettledTurns(accumulator.threadId, Math.max(1, deadline - Date.now()));
        const turn = Array.isArray(thread?.turns)
          ? thread.turns.find((item: any) => String(item?.id ?? item?.turnId ?? "") === turnId)
          : null;
        if (!turn || !turnFinished(turn)) continue;
        return this.rememberCompletedTurn({
          threadId: accumulator.threadId,
          turnId,
          turn,
          items: Array.isArray(turn.items) ? turn.items : accumulator.items,
        });
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        // A transient read failure must not discard a turn whose completion
        // notification can still arrive on the next iteration.
      }
    }
    throw new Error("TURN_TIMEOUT");
  }

  private waitForTurnNotification(turnId: string, timeoutMs: number): Promise<TurnCompletedEvent | null> {
    const already = this.completed.get(turnId);
    if (already) return Promise.resolve(already);
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("turnCompleted", onCompleted);
      };
      const onCompleted = (event: TurnCompletedEvent) => {
        if (event.turnId !== turnId) return;
        cleanup();
        resolve(event);
      };
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);
      this.on("turnCompleted", onCompleted);
      const completedAfterSubscribe = this.completed.get(turnId);
      if (completedAfterSubscribe) { cleanup(); resolve(completedAfterSubscribe); }
    });
  }

  /**
   * The thread's turns, taken from the rollout whenever there is one.
   *
   * Settling a single turn through `thread/read` means receiving the entire
   * conversation in one frame: tens of megabytes on a thread that has run for
   * weeks, and past a point too large to receive or to be worth parsing at
   * all -- at which point a queue prompt would wait for a completion that
   * could no longer be looked up. The rollout is the append-only record the
   * App Server's own projection is built from, so it is both cheaper to read
   * and never behind. The API is asked only for a thread that has not been
   * written to disk yet, which is the one case the file cannot answer.
   */
  private async readSettledTurns(threadId: string, remainingMs: number): Promise<any> {
    const fromRollout = await readCodexRolloutThread(threadId).catch(() => null);
    if (fromRollout) return fromRollout;
    return unwrapThread(await this.readThread(threadId, Math.min(30_000, remainingMs)));
  }

  private rememberCompletedTurn(event: TurnCompletedEvent): TurnCompletedEvent {
    const existing = this.completed.get(event.turnId);
    if (existing) return existing;
    this.turns.delete(event.turnId);
    this.completed.set(event.turnId, event);
    if (event.threadId) this.activeThreads.delete(event.threadId);
    this.emit("turnCompleted", event);
    return event;
  }

  async waitForThreadIdle(threadId: string, timeoutMs = 24 * 60 * 60 * 1000, pollMs = THREAD_SUMMARY_POLL_MS): Promise<void> {
    if (!this.activeThreads.has(threadId)) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.activeThreads.has(threadId)) return;
      const signaled = await this.waitForThreadIdleNotification(threadId, Math.min(Math.max(0, pollMs), Math.max(0, deadline - Date.now())));
      if (signaled || !this.activeThreads.has(threadId)) return;
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const response = await this.readThreadSummary(threadId, Math.min(30_000, remaining));
        const thread = unwrapThread(response);
        if (!threadIdle(thread)) continue;
        this.activeThreads.delete(threadId);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
    }
    throw new Error("THREAD_IDLE_TIMEOUT");
  }

  private waitForThreadIdleNotification(threadId: string, timeoutMs: number): Promise<boolean> {
    if (!this.activeThreads.has(threadId)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.removeListener("turnCompleted", onCompleted);
      };
      const onCompleted = (event: TurnCompletedEvent) => {
        if (event.threadId !== threadId || this.activeThreads.has(threadId)) return;
        cleanup();
        resolve(true);
      };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      this.on("turnCompleted", onCompleted);
      if (!this.activeThreads.has(threadId)) { cleanup(); resolve(true); }
    });
  }

  activeTurnIds(threadId: string): string[] {
    return [...this.turns.values()]
      .filter((turn) => turn.threadId === threadId)
      .map((turn) => turn.turnId);
  }

  close(): void {
    if (this.socket) this.socket.close();
    this.socket = null;
  }
}

function turnFinished(turn: any): boolean {
  const status = String(turn?.status?.type ?? turn?.status ?? turn?.state ?? "").toLowerCase();
  return ["completed", "failed", "interrupted", "canceled", "cancelled"].includes(status);
}

function unwrapThread(response: any): any {
  return response?.thread ?? response?.data?.thread ?? response?.data ?? response;
}

function threadStatus(thread: any): string {
  return String(thread?.status?.type ?? thread?.status ?? thread?.state ?? "").toLowerCase();
}

function threadSettled(thread: any): boolean {
  return ["idle", "completed", "failed", "interrupted", "canceled", "cancelled"].includes(threadStatus(thread));
}

function settledSummaryKey(thread: any): string {
  const revision = thread?.updatedAt
    ?? thread?.updated_at
    ?? thread?.recencyAt
    ?? thread?.recency_at
    ?? thread?.lastActivityAt
    ?? thread?.last_activity_at
    ?? "";
  return `${threadStatus(thread)}:${String(revision)}`;
}

function threadIdle(thread: any): boolean {
  if (threadSettled(thread)) return true;
  return Array.isArray(thread?.turns) && thread.turns.length > 0 && thread.turns.every(turnFinished);
}

export async function waitForThreadLoaded(
  rpc: Pick<CodexRpcClient, "readThreadSummary">,
  threadId: string,
  timeoutMs = 30_000,
  pollMs = 200,
  startupError?: () => string | null,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  let lastError: unknown;
  while (Date.now() < deadline) {
    const terminalError = startupError?.();
    if (terminalError) throw new Error(terminalError);
    try {
      const response = await rpc.readThreadSummary(threadId);
      const thread = response?.thread ?? response?.data?.thread ?? response?.data ?? response;
      lastStatus = String(thread?.status?.type ?? "unknown");
      if (lastStatus === "idle" || lastStatus === "active") return thread;
      if (lastStatus === "systemError") throw new Error(`TUI_THREAD_SYSTEM_ERROR:${thread?.status?.message ?? threadId}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TUI_THREAD_SYSTEM_ERROR:")) throw error;
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  const detail = lastError instanceof Error ? lastError.message : lastStatus;
  throw new Error(`TUI_ATTACH_TIMEOUT:${threadId}:${detail}`);
}

export type CodexManagerStatus = { state: "starting" | "ready" | "error" | "stopped"; url: string | null; error: string | null };

export class AppServerManager extends EventEmitter {
  readonly rpc = new CodexRpcClient();
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private url: string | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private intentionalStop = false;
  private ownershipInfo: AppServerOwnership | null = null;
  private _status: CodexManagerStatus = { state: "stopped", url: null, error: null };

  constructor() {
    super();
    // A dropped RPC socket leaves the child process listening but unreachable.
    // Without this the manager goes on reporting "ready" while every call
    // fails against a socket that is gone, and nothing ever restarts it.
    this.rpc.on("disconnected", () => {
      if (this.intentionalStop || this.stopPromise || this._status.state !== "ready") return;
      void this.discardAfterDisconnect();
    });
  }

  get status(): CodexManagerStatus { return { ...this._status }; }
  get remoteUrl(): string | null { return this.url; }
  get ownership(): AppServerOwnership | null { return this.ownershipInfo ? { ...this.ownershipInfo } : null; }

  async start(): Promise<void> {
    if (this._status.state === "ready") return;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    this.startPromise = this.startInternal();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async startInternal(): Promise<void> {
    this.intentionalStop = false;
    this.ownershipInfo = null;
    this.setStatus({ state: "starting", url: null, error: null });
    try {
      const port = await freePort();
      const command = process.platform === "win32" ? "codex.cmd" : "codex";
      const startedAt = new Date().toISOString();
      this.port = port;
      this.url = `ws://127.0.0.1:${port}`;
      this.process = spawn(command, ["app-server", "--listen", this.url], {
        cwd: process.cwd(),
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.process.on("exit", (code) => {
        if (this.intentionalStop) return;
        if (this._status.state === "ready" || this._status.state === "starting") {
          this.setStatus({ state: "error", url: this.url, error: `APP_SERVER_EXIT:${code ?? "unknown"}` });
        }
      });
      await waitForHttpReady(`http://127.0.0.1:${port}/readyz`, 15_000);
      await connectWithRetry(this.rpc, this.url, 15_000);
      this.ownershipInfo = await captureAppServerOwnership(port, this.process?.pid ?? null, startedAt);
      this.setStatus({ state: "ready", url: this.url, error: null });
    } catch (error) {
      this.rpc.close();
      const child = this.process;
      this.process = null;
      if (child?.pid) await terminateProcessTree(child.pid).catch(() => undefined);
      this.ownershipInfo = null;
      this.setStatus({ state: "error", url: this.url, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async ensureReady(): Promise<CodexRpcClient> {
    if (this._status.state !== "ready") await this.start();
    if (this._status.state !== "ready") throw new Error(this._status.error ?? "CODEX_APP_SERVER_UNAVAILABLE");
    return this.rpc;
  }

  async version(): Promise<string> {
    const command = process.platform === "win32" ? "codex.cmd" : "codex";
    const result = await execFileAsync(command, ["--version"], { windowsHide: true, shell: process.platform === "win32" });
    return String(result.stdout).trim();
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopInternal();
    try { await this.stopPromise; } finally { this.stopPromise = null; }
  }

  private async stopInternal(): Promise<void> {
    this.intentionalStop = true;
    await this.rpc.releaseLoadedThreads(1_500).catch(() => undefined);
    this.rpc.close();
    const child = this.process;
    const port = this.port;
    const ownership = this.ownershipInfo;
    this.process = null;
    this.ownershipInfo = null;
    if (child?.pid) await terminateProcessTree(child.pid).catch(() => undefined);
    if (port !== null) {
      try {
        await waitForPortClosed(port, 750);
      } catch {
        if (ownership) await terminateStaleAppServer(ownership);
        await waitForPortClosed(port, 5_000);
      }
    }
    this.port = null;
    this.url = null;
    this.setStatus({ state: "stopped", url: null, error: null });
  }

  /** Retire a server that can no longer be reached, so the next ensureReady starts a fresh one. */
  private async discardAfterDisconnect(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.ownershipInfo = null;
    this.setStatus({ state: "error", url: this.url, error: "CODEX_APP_SERVER_DISCONNECTED" });
    if (child?.pid) await terminateProcessTree(child.pid).catch(() => undefined);
  }

  private setStatus(status: CodexManagerStatus): void {
    this._status = status;
    this.emit("status", this.status);
  }
}

export type CodexPoolStatus = CodexManagerStatus & {
  readyCount: number;
  startingCount: number;
  errorCount: number;
  totalCount: number;
};

export class AppServerPool extends EventEmitter {
  private readonly managers = new Map<string, AppServerManager>();

  get(tabId: string): AppServerManager {
    let manager = this.managers.get(tabId);
    if (manager) return manager;
    manager = new AppServerManager();
    this.managers.set(tabId, manager);
    manager.on("status", (status) => this.emit("status", { tabId, status, aggregate: this.status }));
    this.emit("created", { tabId, manager });
    return manager;
  }

  existing(tabId: string): AppServerManager | null { return this.managers.get(tabId) ?? null; }

  get status(): CodexPoolStatus {
    const statuses = [...this.managers.values()].map((manager) => manager.status);
    const readyCount = statuses.filter((status) => status.state === "ready").length;
    const startingCount = statuses.filter((status) => status.state === "starting").length;
    const errorCount = statuses.filter((status) => status.state === "error").length;
    const state: CodexManagerStatus["state"] = errorCount ? "error" : startingCount ? "starting" : readyCount ? "ready" : "stopped";
    return { state, url: null, error: errorCount ? `${errorCount} conversation service(s) failed` : null, readyCount, startingCount, errorCount, totalCount: statuses.length };
  }

  async stop(tabId: string): Promise<void> {
    const manager = this.managers.get(tabId);
    if (!manager) return;
    try {
      await manager.stop();
    } finally {
      this.managers.delete(tabId);
      this.emit("removed", { tabId, aggregate: this.status });
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managers.entries()].map(async ([tabId, manager]) => {
      await manager.stop();
      this.managers.delete(tabId);
    }));
  }
}

type ListeningProcess = {
  pid: number;
  commandLine: string;
  startedAt: string;
};

/**
 * Terminates only a listener whose PID, endpoint and creation time match an
 * App Server previously launched by this tool. This is used after an
 * ungraceful backend exit, when the original launcher process may be gone.
 */
export async function terminateStaleAppServer(ownership: AppServerOwnership): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const listener = await inspectWindowsAppServerListener(ownership.port);
  if (!listener || !matchesOwnership(listener, ownership)) return false;
  await terminateProcessTree(listener.pid);
  await waitForPortClosed(ownership.port, 5_000);
  return true;
}

async function captureAppServerOwnership(port: number, launcherPid: number | null, fallbackStartedAt: string): Promise<AppServerOwnership> {
  const listener = process.platform === "win32" ? await inspectWindowsAppServerListener(port) : null;
  return {
    launcherPid,
    listenerPid: listener?.pid ?? null,
    port,
    startedAt: listener?.startedAt ?? fallbackStartedAt,
  };
}

function matchesOwnership(listener: ListeningProcess, ownership: AppServerOwnership): boolean {
  if (ownership.listenerPid === null || listener.pid !== ownership.listenerPid) return false;
  const expectedEndpoint = `ws://127.0.0.1:${ownership.port}`.toLowerCase();
  const commandLine = listener.commandLine.toLowerCase();
  if (!commandLine.includes("app-server") || !commandLine.includes(expectedEndpoint)) return false;
  const expectedStart = Date.parse(ownership.startedAt);
  const actualStart = Date.parse(listener.startedAt);
  return Number.isFinite(expectedStart) && Number.isFinite(actualStart) && Math.abs(expectedStart - actualStart) <= 2_000;
}

async function inspectWindowsAppServerListener(port: number): Promise<ListeningProcess | null> {
  if (process.platform !== "win32") return null;
  const script = [
    `$connection = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if ($null -eq $connection) { exit 4 }",
    "$processInfo = Get-CimInstance Win32_Process -Filter \"ProcessId = $($connection.OwningProcess)\" -ErrorAction SilentlyContinue",
    "if ($null -eq $processInfo) { exit 5 }",
    "$startedAt = $processInfo.CreationDate.ToUniversalTime().ToString('o')",
    "[pscustomobject]@{ pid = [int]$processInfo.ProcessId; commandLine = [string]$processInfo.CommandLine; startedAt = $startedAt } | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const result = await execFileAsync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const value = JSON.parse(String(result.stdout).trim());
    const pid = Number(value?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, commandLine: String(value?.commandLine ?? ""), startedAt: String(value?.startedAt ?? "") };
  } catch {
    return null;
  }
}

export async function terminateProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    } catch (error: any) {
      const text = `${error?.message ?? ""}\n${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
      if (!/not found|no running instance|找不到|没有运行的实例/i.test(text)) throw error;
    }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch {
    try { process.kill(pid, "SIGTERM"); } catch { return; }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  try { process.kill(-pid, "SIGKILL"); } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function connectWithRetry(rpc: CodexRpcClient, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { await rpc.connect(url); return; } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("APP_SERVER_CONNECT_TIMEOUT");
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`READY_HTTP_${response.status}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError instanceof Error ? lastError : new Error("APP_SERVER_READY_TIMEOUT");
}

async function waitForPortClosed(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(250, () => finish(false));
    });
    if (!open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`APP_SERVER_PORT_STILL_OPEN:${port}`);
}


function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}
