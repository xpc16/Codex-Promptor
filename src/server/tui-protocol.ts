export type TuiThreadMethod = "thread/start" | "thread/resume" | "thread/fork";

export type TuiThreadSelection = {
  method: TuiThreadMethod;
  thread: any;
  requestedThreadId: string | null;
  requestedCwd: string | null;
};

export type TuiThreadSelectionHandler = (selection: TuiThreadSelection) => Promise<void> | void;

type PendingThreadRequest = {
  method: TuiThreadMethod;
  params: any;
};

const THREAD_SELECTION_METHODS = new Set<TuiThreadMethod>([
  "thread/start",
  "thread/resume",
  "thread/fork",
]);

/**
 * Observes the JSON-RPC traffic of one Codex TUI connection. It never changes
 * messages; it only correlates successful thread-selection responses with the
 * request that caused them.
 */
export class TuiThreadRequestTracker {
  private readonly pending = new Map<number | string, PendingThreadRequest>();

  observeClientMessage(raw: string): void {
    const message = parseObject(raw);
    if (!message || message.id === undefined || typeof message.method !== "string") return;
    if (!THREAD_SELECTION_METHODS.has(message.method as TuiThreadMethod)) return;
    this.pending.set(message.id, {
      method: message.method as TuiThreadMethod,
      params: message.params ?? {},
    });
  }

  observeServerMessage(raw: string): TuiThreadSelection | null {
    const message = parseObject(raw);
    if (!message || message.id === undefined) return null;
    const request = this.pending.get(message.id);
    if (!request) return null;
    this.pending.delete(message.id);
    if (message.error) return null;

    const thread = message.result?.thread ?? message.result?.data?.thread ?? message.result?.data ?? message.result;
    const requestedThreadId = stringOrNull(request.params?.threadId);
    const requestedCwd = stringOrNull(request.params?.cwd);
    const threadId = stringOrNull(thread?.id ?? thread?.threadId) ?? requestedThreadId;
    if (!threadId) return null;
    return {
      method: request.method,
      thread: thread && typeof thread === "object" ? { ...thread, id: threadId } : { id: threadId },
      requestedThreadId,
      requestedCwd,
    };
  }

  clear(): void { this.pending.clear(); }
}

/**
 * Captures the first thread/start selected by a newly launched remote TUI.
 * Later TUI selections are held until the tab has persisted its initial
 * binding, then forwarded in order to the normal thread-switch handler.
 */
export class InitialTuiThreadGate {
  private initialSelection: TuiThreadSelection | null = null;
  private failure: Error | null = null;
  private state: "waiting" | "binding" | "active" | "failed" = "waiting";
  private readonly queued: TuiThreadSelection[] = [];

  constructor(private readonly onFollowingSelection: TuiThreadSelectionHandler) {}

  readonly observe = async (selection: TuiThreadSelection): Promise<void> => {
    if (this.state === "failed") return;
    if (this.state === "waiting") {
      if (selection.method !== "thread/start") {
        this.cancel(new Error(`TUI_NEW_THREAD_EXPECTED:${selection.method}`));
        return;
      }
      this.initialSelection = selection;
      this.state = "binding";
      return;
    }
    if (this.state === "binding") {
      this.queued.push(selection);
      return;
    }
    await this.onFollowingSelection(selection);
  };

  cancel(reason: unknown): void {
    if (this.state === "active" || this.state === "failed") return;
    this.failure = reason instanceof Error ? reason : new Error(String(reason));
    this.state = "failed";
  }

  async wait(
    startupError: () => string | null,
    timeoutMs = 30_000,
    pollMs = 50,
  ): Promise<TuiThreadSelection> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.failure) throw this.failure;
      if (this.initialSelection) return this.initialSelection;
      const terminalError = startupError();
      if (terminalError) {
        this.cancel(new Error(terminalError));
        throw this.failure;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    this.cancel(new Error("TUI_NEW_THREAD_TIMEOUT"));
    throw this.failure;
  }

  async activate(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.initialSelection) throw new Error("TUI_NEW_THREAD_NOT_SELECTED");
    if (this.state === "active") return;
    this.state = "active";
    const queued = this.queued.splice(0);
    for (const selection of queued) await this.onFollowingSelection(selection);
  }
}

function parseObject(raw: string): any | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}
