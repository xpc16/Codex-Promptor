import { EventEmitter } from "node:events";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import WebSocket from "ws";

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

export class CodexRpcClient extends EventEmitter {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly turns = new Map<string, TurnAccumulator>();
  private readonly completed = new Map<string, TurnCompletedEvent>();
  private readonly activeThreads = new Set<string>();
  private connectPromise: Promise<void> | null = null;

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  async connect(url: string): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        if (this.socket === socket) this.socket = null;
        try { socket.close(); } catch { /* socket may not have opened */ }
        reject(error);
      };
      const onSocketError = (error: Error) => {
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
          socket.on("error", (error) => this.emit("error", error));
          resolve();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("message", (data) => this.handleMessage(data.toString()));
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

  private handleMessage(raw: string): void {
    let message: RpcMessage;
    try { message = JSON.parse(raw) as RpcMessage; } catch { return; }
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
    } else if (method === "turn/completed") {
      const turn = params.turn ?? params;
      const threadId = String(params.threadId ?? turn.threadId ?? "");
      const turnId = String(params.turnId ?? turn.id ?? "");
      const accumulator = this.turns.get(turnId) ?? { threadId, turnId, turn, items: [], startedAt: turn.startedAt ?? null };
      accumulator.turn = turn;
      if (Array.isArray(turn.items)) accumulator.items = turn.items;
      const event: TurnCompletedEvent = { threadId: accumulator.threadId, turnId, turn, items: accumulator.items };
      this.turns.delete(turnId);
      this.completed.set(turnId, event);
      if (threadId) this.activeThreads.delete(threadId);
      this.emit("turnCompleted", event);
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

  async readThread(threadId: string): Promise<any> {
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  async resumeThread(threadId: string, cwd: string): Promise<any> {
    return this.request("thread/resume", { threadId, cwd });
  }

  async interruptTurn(threadId: string, turnId: string): Promise<any> {
    return this.request("turn/interrupt", { threadId, turnId });
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

  async waitForTurn(turnId: string, timeoutMs = 24 * 60 * 60 * 1000): Promise<TurnCompletedEvent> {
    const already = this.completed.get(turnId);
    if (already) return already;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("turnCompleted", onCompleted);
        reject(new Error("TURN_TIMEOUT"));
      }, timeoutMs);
      const onCompleted = (event: TurnCompletedEvent) => {
        if (event.turnId !== turnId) return;
        clearTimeout(timer);
        this.removeListener("turnCompleted", onCompleted);
        resolve(event);
      };
      this.on("turnCompleted", onCompleted);
    });
  }

  async waitForThreadIdle(threadId: string, timeoutMs = 24 * 60 * 60 * 1000): Promise<void> {
    if (!this.activeThreads.has(threadId)) return;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener("turnCompleted", onCompleted);
        reject(new Error("THREAD_IDLE_TIMEOUT"));
      }, timeoutMs);
      const onCompleted = (event: TurnCompletedEvent) => {
        if (event.threadId !== threadId || this.activeThreads.has(threadId)) return;
        clearTimeout(timer);
        this.removeListener("turnCompleted", onCompleted);
        resolve();
      };
      this.on("turnCompleted", onCompleted);
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

export type CodexManagerStatus = { state: "starting" | "ready" | "error" | "stopped"; url: string | null; error: string | null };

export class AppServerManager extends EventEmitter {
  readonly rpc = new CodexRpcClient();
  private process: ChildProcess | null = null;
  private port: number | null = null;
  private url: string | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private intentionalStop = false;
  private _status: CodexManagerStatus = { state: "stopped", url: null, error: null };

  get status(): CodexManagerStatus { return { ...this._status }; }
  get remoteUrl(): string | null { return this.url; }

  async start(): Promise<void> {
    if (this._status.state === "ready") return;
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    this.startPromise = this.startInternal();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  private async startInternal(): Promise<void> {
    this.intentionalStop = false;
    this.setStatus({ state: "starting", url: null, error: null });
    try {
      const port = await freePort();
      const command = process.platform === "win32" ? "codex.cmd" : "codex";
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
      this.setStatus({ state: "ready", url: this.url, error: null });
    } catch (error) {
      this.rpc.close();
      const child = this.process;
      this.process = null;
      if (child?.pid) await terminateProcessTree(child.pid).catch(() => undefined);
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
    this.rpc.close();
    const child = this.process;
    const port = this.port;
    this.process = null;
    if (child?.pid) await terminateProcessTree(child.pid);
    if (port !== null) await waitForPortClosed(port, 5_000);
    this.port = null;
    this.url = null;
    this.setStatus({ state: "stopped", url: null, error: null });
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
    await manager.stop();
    this.managers.delete(tabId);
    this.emit("removed", { tabId, aggregate: this.status });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managers.entries()].map(async ([tabId, manager]) => {
      await manager.stop();
      this.managers.delete(tabId);
    }));
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
