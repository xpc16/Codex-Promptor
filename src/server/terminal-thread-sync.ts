import { isoNow } from "../shared/schemas.js";
import { readCodexThreadForHistory } from "./codex-history.js";
import { durableThreadOrigin } from "./codex-thread-fallback.js";
import { syncHistory, type HistoryReport } from "./history.js";
import type { StorageService } from "./storage.js";
import type { TuiThreadSelection } from "./tui-protocol.js";

export type TerminalThreadRpc = {
  readThread(threadId: string, timeoutMs?: number): Promise<any>;
  readThreadSummary(threadId: string, timeoutMs?: number): Promise<any>;
  resumeThread(threadId: string, cwd: string): Promise<any>;
};

export type TerminalThreadRunner = {
  freeze(): Promise<void>;
  start(): Promise<void>;
};

export type TerminalThreadSwitchResult = {
  previousThreadId: string;
  threadId: string;
  sessionId: string;
  workingDirectory: string;
  switchedAt: string;
  method: TuiThreadSelection["method"];
  report: HistoryReport;
  runnerResumed: boolean;
};

export async function syncTerminalThreadSelection(options: {
  storage: StorageService;
  tabId: string;
  rpc: TerminalThreadRpc;
  runner: TerminalThreadRunner;
  selection: TuiThreadSelection;
  isCurrent?: () => boolean;
  /**
   * Whether a thread has a rollout on disk. A thread that `thread/start` just
   * created has none until the first prompt lands, and recording such an id as
   * the origin of the switch loses the way back to the conversation (see
   * `durableThreadOrigin`). Absent, every thread is assumed durable, which is
   * the behaviour this had before.
   */
  isDurableThread?: (threadId: string) => Promise<boolean>;
}): Promise<TerminalThreadSwitchResult | null> {
  const { storage, tabId, rpc, runner, selection } = options;
  const isCurrent = options.isCurrent ?? (() => true);
  const targetThreadId = String(selection.thread?.id ?? selection.thread?.threadId ?? selection.requestedThreadId ?? "");
  if (!targetThreadId) return null;

  const before = await storage.readTab(tabId);
  const previousThreadId = before.tab.session.threadId;
  if (before.tab.session.state !== "ready" || !previousThreadId || previousThreadId === targetThreadId || !isCurrent()) return null;

  const shouldResumeRunner = before.runtime.runner.desiredState === "running";
  await runner.freeze();
  if (!isCurrent()) return null;

  let rebound = false;
  let runnerResumed = false;
  try {
    // The TUI may resume stored history with a live cwd override. Prefer the
    // request value so the queue follows the directory shown by the terminal.
    const announcedCwd = nonEmptyString(selection.requestedCwd) ?? nonEmptyString(selection.thread?.cwd) ?? before.tab.session.workingDirectory;
    if (!announcedCwd) throw new Error("TUI_THREAD_CWD_MISSING");
    const announcedSessionId = nonEmptyString(selection.thread?.sessionId) ?? targetThreadId;
    const switchedAt = isoNow();
    const previousIsDurable = options.isDurableThread
      ? await options.isDurableThread(previousThreadId).catch(() => true)
      : true;
    const fromThreadId = durableThreadOrigin({
      previousThreadId,
      previousIsDurable,
      carriedFromThreadId: before.tab.session.lastThreadSwitch?.fromThreadId ?? null,
    });

    // Bind first so any new turn emitted immediately after the TUI response is
    // attributed to the selected thread, then subscribe this controller client.
    await storage.updateTab(tabId, (current) => ({
      ...current,
      session: {
        ...current.session,
        state: "ready",
        workingDirectory: announcedCwd,
        threadId: targetThreadId,
        sessionId: announcedSessionId,
        connectedAt: switchedAt,
        lastError: null,
        lastThreadSwitch: {
          fromThreadId,
          toThreadId: targetThreadId,
          method: selection.method,
          switchedAt,
        },
      },
      updatedAt: switchedAt,
    }));
    rebound = true;

    await rpc.resumeThread(targetThreadId, announcedCwd);
    const storedThread = await readCodexThreadForHistory(rpc, targetThreadId);
    const returnedThreadId = nonEmptyString(storedThread?.id ?? storedThread?.threadId);
    if (returnedThreadId && returnedThreadId !== targetThreadId) throw new Error(`TUI_THREAD_ID_MISMATCH:${returnedThreadId}`);

    const workingDirectory = nonEmptyString(storedThread?.cwd) ?? announcedCwd;
    const sessionId = nonEmptyString(storedThread?.sessionId) ?? announcedSessionId;
    if (workingDirectory !== announcedCwd || sessionId !== announcedSessionId) {
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, workingDirectory, sessionId },
        updatedAt: isoNow(),
      }));
    }
    const report = await syncHistory(storage, tabId, storedThread);

    if (shouldResumeRunner && isCurrent()) {
      await runner.start();
      runnerResumed = true;
    }
    return {
      previousThreadId,
      threadId: targetThreadId,
      sessionId,
      workingDirectory,
      switchedAt,
      method: selection.method,
      report,
      runnerResumed,
    };
  } catch (error) {
    if (rebound) {
      const message = error instanceof Error ? error.message : String(error);
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          ...current.session,
          lastError: { code: "TERMINAL_THREAD_SYNC_FAILED", message: `PowerShell 已切换对话，但历史同步失败：${message}` },
        },
        updatedAt: isoNow(),
      })).catch(() => undefined);
    }
    throw error;
  } finally {
    if (shouldResumeRunner && !runnerResumed && isCurrent()) {
      const current = await storage.getTabMeta(tabId).catch(() => null);
      if (current?.session.state === "ready") await runner.start().catch(() => undefined);
    }
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
