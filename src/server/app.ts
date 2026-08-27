import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { AgentProviderSchema, type AgentProvider, type AnswerRecord, type Group, type IndexFile, IndexFileSchema, isoNow, newPrompt, PromptFileSchema, RuntimeFileSchema, type RuntimeFile, type TabBundle, type TabMeta } from "../shared/schemas.js";
import { settledDesiredState, type TabActivitySummary } from "../shared/tab-activity.js";
import type { PromptDelta } from "../shared/tab-delta.js";
import { reorderPromptIds } from "../shared/prompt-order.js";
import {
  EARLIER_ANSWER_PAGE,
  EARLIER_PROMPT_PAGE,
  INITIAL_ANSWER_WINDOW,
  INITIAL_PROMPT_WINDOW,
  MAX_WINDOW_RECORDS,
} from "../shared/tab-window.js";
import { AppServerPool, type AppServerManager, terminateStaleAppServer, waitForThreadLoaded } from "./codex.js";
import { ClaudeCodePool, type ClaudeCodeManager, probeClaudeVersion } from "./claude.js";
import { syncClaudeHistory } from "./claude-history.js";
import { buildCursorCommand, CursorCliPool, type CursorCliManager, ensureCursorHookBridge, probeCursorVersion } from "./cursor.js";
import { syncCursorHistory } from "./cursor-history.js";
import { DirectoryPickerBusyError, DirectoryPickerService } from "./directory-picker.js";
import { DocumentError, DocumentService, isLocalBrowserRequest } from "./documents.js";
import { withCodexRolloutTurns } from "./codex-history.js";
import { historyThreadFromResponse, recordTurn, syncHistory } from "./history.js";
import { applyNavigationOrder, deleteGroupAndUngroupTabs } from "./navigation.js";
import { entityTag, ifNoneMatchSatisfied, REVALIDATE_CACHE_CONTROL, REVALIDATE_VARY } from "./http-cache.js";
import { CLAUDE_EXIT_MARKER, CURSOR_EXIT_MARKER, PtyManager, type TerminalCursor } from "./pty.js";
import { RunnerManager } from "./queue.js";
import { StorageService } from "./storage.js";
import {
  BoundedWebSocketSender,
  decodeTerminalInput,
  RawTerminalBatcher,
  TERMINAL_PROTOCOL_VERSION,
  TerminalTrafficMeter,
  terminalTransportConfigFromEnv,
  type TerminalTrafficKind,
} from "./terminal-transport.js";
import { defaultProjectionSchedulerConfig, fullTerminalScreenFrame, TerminalProjectionScheduler } from "./terminal-projection.js";
import { createTrafficLedger, rollupBuckets, type TrafficLedger } from "./traffic-ledger.js";
import { createTrafficLog } from "./traffic-log.js";
import { syncTerminalThreadSelection } from "./terminal-thread-sync.js";
import { InitialTuiThreadGate, type TuiThreadSelection, type TuiThreadSelectionHandler } from "./tui-protocol.js";
import { TuiProxyPool } from "./tui-proxy.js";
import { DEFAULT_UI_GRACE_MS, UiLifecycle } from "./ui-lifecycle.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidResumeId(provider: AgentProvider, resumeId: string): boolean {
  if (provider !== "cursor") return UUID_RE.test(resumeId);
  return resumeId.length > 0 && resumeId.length <= 256 && !/[\x00-\x1f\x7f]/.test(resumeId);
}

type RawTerminalStream = {
  mode: "raw";
  cursor: TerminalCursor;
  streamId: string;
  sequence: number;
};

type ProjectionTerminalStream = {
  mode: "projection";
  viewportRows: number;
  fps: number;
  streamId: string;
};

type TerminalStream = RawTerminalStream | ProjectionTerminalStream;

type Client = {
  id: string;
  socket: any;
  stateSubscriptions: Set<string>;
  terminalSubscriptions: Map<string, TerminalStream>;
  wantsIndex: boolean;
  wantsDetails: boolean;
};

export type RestoreOpenSessionsSummary = {
  restored: string[];
  failed: Array<{ tabId: string; code: string; message: string }>;
};

type TerminalReopenResult =
  | { ok: true; bundle: TabBundle }
  | { ok: false; statusCode: number; code: string; message: string };

export function answerEventType(answer: Pick<AnswerRecord, "status">): "answer.added" | "answer.changed" {
  return answer.status === "completed" ? "answer.added" : "answer.changed";
}

export type PromptorApp = FastifyInstance & {
  promptor: {
    storage: StorageService;
    codex: AppServerPool;
    claude: ClaudeCodePool;
    cursor: CursorCliPool;
    pty: PtyManager;
    runners: RunnerManager;
    ui: UiLifecycle;
    traffic: TerminalTrafficMeter;
    documents: DocumentService;
    token: string;
    restoreOpenSessions: () => Promise<RestoreOpenSessionsSummary>;
    close: () => Promise<void>;
  };
};

export async function createApp(rootDir: string): Promise<PromptorApp> {
  const app = Fastify({ logger: false }) as unknown as PromptorApp;
  const storage = new StorageService(rootDir);
  const codex = new AppServerPool();
  const pty = new PtyManager();
  const claude = new ClaudeCodePool(pty);
  const cursor = new CursorCliPool(pty);
  const tuiProxy = new TuiProxyPool();
  const directoryPicker = new DirectoryPickerService();
  const ui = new UiLifecycle(Number(process.env.CODEX_PROMPTOR_UI_GRACE_MS ?? DEFAULT_UI_GRACE_MS));
  const token = process.env.CODEX_PROMPTOR_TOKEN ?? randomBytes(32).toString("hex");
  const clients = new Set<Client>();
  const sequences = new Map<string, number>();
  const transportConfig = terminalTransportConfigFromEnv();
  const traffic = new TerminalTrafficMeter();
  const socketSender = new BoundedWebSocketSender(traffic, transportConfig);
  // What this service sends and receives, by kind, minute by minute. The live
  // meter above answers "what is this connection doing now"; this answers
  // "what did we spend bytes on all week", which is the question that decides
  // what to cut. Disable with CODEX_PROMPTOR_TRAFFIC_LOG=0.
  const trafficLoggingEnabled = process.env.CODEX_PROMPTOR_TRAFFIC_LOG !== "0";
  const ledger: TrafficLedger = createTrafficLedger({
    bucketMs: boundedInteger(process.env.CODEX_PROMPTOR_TRAFFIC_BUCKET_MS, 5_000, 3_600_000, 60_000),
  });
  const trafficLog = createTrafficLog(storage.dataDir, {
    retainedDays: boundedInteger(process.env.CODEX_PROMPTOR_TRAFFIC_RETAIN_DAYS, 1, 365, 14),
  });
  const recordTraffic = (
    direction: "out" | "in",
    channel: "ws" | "http",
    type: string,
    bytes: number,
    rawBytes?: number,
  ): void => {
    if (trafficLoggingEnabled) ledger.record(direction, channel, type, bytes, rawBytes);
  };
  const terminalResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const rawResponderOwners = new Map<string, string>();
  const responderLeaseEpochs = new Map<string, number>();
  const pendingApprovals = new Map<string, { tabId: string; manager: AppServerManager; requestId: number | string }>();
  const threadSwitches = new Map<string, Promise<void>>();
  const noAuth = process.env.CODEX_PROMPTOR_NO_AUTH === "1";
  // Hosts beyond 127.0.0.1/localhost that a reverse proxy (e.g. a Cloudflare
  // Tunnel hostname already gated by Cloudflare Access) forwards requests for.
  // The browser's Origin/Referer still has to match exactly, so this only
  // widens *which* host is eligible for the same-origin check below — it
  // does not skip the check itself.
  const trustedHosts = (process.env.CODEX_PROMPTOR_TRUSTED_HOSTS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const claudeVersion = probeClaudeVersion();
  const cursorVersion = probeCursorVersion();

  await storage.ensure();
  const documents = await DocumentService.create(rootDir, storage);
  const readClientTab = (tabId: string): Promise<TabBundle> => storage.readTabWindow(tabId, INITIAL_PROMPT_WINDOW, INITIAL_ANSWER_WINDOW);
  const startupOpenTabIds = tabsToRestore(await storage.listTabMeta());
  await recoverTerminalRuntime(storage);

  const sendClient = (client: Client, message: Record<string, unknown>, kind: TerminalTrafficKind): boolean => {
    const payload = JSON.stringify(message);
    const sent = socketSender.send(client.id, client.socket, payload, kind);
    // Counted only when it actually left: a frame dropped for backpressure
    // costs no bandwidth, and counting it would hide the drop.
    if (sent) recordTraffic("out", "ws", String(message.type ?? kind), Buffer.byteLength(payload, "utf8"));
    return sent;
  };

  const projectionScheduler = new TerminalProjectionScheduler(
    (tabId, viewportRows) => pty.screenSnapshot(tabId, viewportRows),
    {
      ...defaultProjectionSchedulerConfig,
      backpressureHighBytes: transportConfig.websocketHighWaterBytes,
      backpressureLowBytes: transportConfig.websocketLowWaterBytes,
      interactiveWindowMs: transportConfig.interactiveWindowMs,
      interactiveOutputMaxBytes: transportConfig.interactiveOutputMaxBytes,
      bytesPerSecond: transportConfig.projectionBytesPerSecond,
      maxBurstBytes: transportConfig.projectionMaxBurstBytes,
    },
  );

  const emit = (tabId: string, message: Record<string, unknown>, detailsOnly = false) => {
    const sequence = (sequences.get(tabId) ?? 0) + 1;
    sequences.set(tabId, sequence);
    for (const client of clients) {
      if (client.stateSubscriptions.has(tabId) && (!detailsOnly || client.wantsDetails)) sendClient(client, { ...message, tabId, sequence }, stateTrafficKind(message.type));
    }
  };

  const sendRawTerminal = (
    client: Client,
    tabId: string,
    message: Record<string, unknown>,
    kind: "terminal.raw" | "terminal.snapshot",
  ): boolean => {
    const stream = client.terminalSubscriptions.get(tabId);
    if (!stream || stream.mode !== "raw") return false;
    stream.sequence += 1;
    return sendClient(client, { ...message, tabId, streamId: stream.streamId, sequence: stream.sequence }, kind);
  };

  const emitRawTerminal = (
    tabId: string,
    message: Record<string, unknown>,
    kind: "terminal.raw" | "terminal.snapshot" = "terminal.raw",
  ): void => {
    for (const client of clients) sendRawTerminal(client, tabId, message, kind);
  };

  const rawBatcher = new RawTerminalBatcher((chunk) => {
    emitRawTerminal(chunk.tabId, {
      type: "terminal.output",
      generation: chunk.generation,
      startOffset: chunk.startOffset,
      endOffset: chunk.endOffset,
      reset: false,
      dataBase64: chunk.dataBase64,
    });
  }, transportConfig);

  const refreshResponderLease = (tabId: string): void => {
    const rawClients = [...clients].filter((candidate) => candidate.socket.readyState === 1 && candidate.terminalSubscriptions.get(tabId)?.mode === "raw");
    const previousOwner = rawResponderOwners.get(tabId) ?? null;
    const owner = rawClients.some((candidate) => candidate.id === previousOwner)
      ? previousOwner
      : rawClients[0]?.id ?? null;
    if (owner) rawResponderOwners.set(tabId, owner);
    else rawResponderOwners.delete(tabId);
    // The browser raw emulator owns DA/DSR/theme replies while a healthy raw
    // stream exists. Projection-only tabs are answered by the headless model.
    pty.setScreenResponder(tabId, rawClients.length === 0);
    const epoch = owner === previousOwner
      ? (responderLeaseEpochs.get(tabId) ?? 0)
      : (responderLeaseEpochs.get(tabId) ?? 0) + 1;
    responderLeaseEpochs.set(tabId, epoch);
    for (const candidate of rawClients) {
      sendClient(candidate, {
        type: "terminal.lease",
        tabId,
        mode: "raw",
        writable: candidate.id === owner,
        responder: candidate.id === owner,
        leaseEpoch: epoch,
      }, "state");
    }
  };

  // Terminal traffic is per-tab, so emit() only reaches subscribers. Navigation
  // is not: every viewer reads the same index file, so a rename, deletion,
  // group move or reorder made in one browser has to reach all the others —
  // otherwise a phone and the desktop drift apart until someone reloads, and
  // the stale one can overwrite the fresh one on the next reorder.
  const broadcastIndex = (index: IndexFile) => {
    for (const client of clients) {
      if (client.wantsIndex) sendClient(client, { type: "index.changed", index }, "index");
    }
  };
  storage.onIndexChanged(broadcastIndex);
  storage.onTabChanged((tabId, tab) => emit(tabId, { type: "tab.changed", tab }, true));
  storage.onPromptsChanged((tabId, delta) => emit(tabId, { type: "prompts.changed", delta }, true));
  storage.onAnswersChanged((tabId, delta) => {
    emit(tabId, { type: "answers.changed", delta }, true);
  });
  storage.onRuntimeChanged((tabId, runtime) => emit(tabId, { type: "runner.changed", runner: runtime }));

  const scheduleCompactionTerminalResync = (tabId: string): void => {
    const previous = terminalResyncTimers.get(tabId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      terminalResyncTimers.delete(tabId);
      rawBatcher.flush(tabId);
      const terminal = pty.snapshot(tabId, {});
      if (terminal) emitRawTerminal(tabId, { type: "terminal.output", reason: "context_compacted", ...terminal }, "terminal.snapshot");
      projectionScheduler.forceFull(tabId);
    }, 650);
    timer.unref?.();
    terminalResyncTimers.set(tabId, timer);
  };

  const runners = new RunnerManager(storage, (tabId) => cursor.existing(tabId) ?? claude.existing(tabId) ?? codex.get(tabId), (event) => {
    if (event.type === "error") emit(event.tabId, { type: "error", error: event.data });
    if (event.type === "answer") {
      const answer = event.data as AnswerRecord | undefined;
      if (answer?.origin === "queue" && answer.status === "completed") {
        emit(event.tabId, {
          type: "answer.activity",
          answerId: answer.id,
          completedAt: answer.completedAt ?? answer.recordedAt,
          status: answer.status,
          origin: answer.origin,
        });
      }
    }
  });

  const scheduleThreadSwitch = (tabId: string, manager: AppServerManager, selection: TuiThreadSelection): Promise<void> => {
    const previous = threadSwitches.get(tabId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (codex.existing(tabId) !== manager) return;
      const result = await syncTerminalThreadSelection({
        storage,
        tabId,
        rpc: manager.rpc,
        runner: runners.get(tabId),
        selection,
        isCurrent: () => codex.existing(tabId) === manager,
      });
      if (!result) return;
      emit(tabId, { type: "thread.switched", switch: result });
      emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true);
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      emit(tabId, { type: "error", error: { code: "TERMINAL_THREAD_SYNC_FAILED", message } });
      try { emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true); } catch { /* tab may have been deleted */ }
    });
    threadSwitches.set(tabId, task);
    void task.finally(() => {
      if (threadSwitches.get(tabId) === task) threadSwitches.delete(tabId);
    });
    return task;
  };

  const startTuiProxy = async (
    tabId: string,
    manager: AppServerManager,
    onThreadSelection: TuiThreadSelectionHandler = (selection) => scheduleThreadSwitch(tabId, manager, selection),
    onError?: (error: Error) => void,
  ): Promise<string> => {
    if (!manager.remoteUrl) throw new Error("APP_SERVER_REMOTE_URL_MISSING");
    return tuiProxy.start(tabId, manager.remoteUrl, {
      onThreadSelection,
      onContextCompacted: () => scheduleCompactionTerminalResync(tabId),
      onError: (error) => {
        onError?.(error);
        emit(tabId, { type: "error", error: { code: "CODEX_REMOTE_BRIDGE_ERROR", message: error.message } });
      },
    });
  };
  const awaitThreadSwitch = async (tabId: string): Promise<void> => {
    await threadSwitches.get(tabId);
  };

  codex.on("created", ({ tabId, manager }: { tabId: string; manager: AppServerManager }) => {
    manager.rpc.on("turnCompleted", async (event: any) => {
      try {
        const tab = await storage.getTabMeta(tabId);
        if (tab.session.threadId !== event.threadId) return;
        const bundle = await storage.readTab(tabId);
        // The queue runner records its own active turn after waitForTurn resolves.
        // Other turns may still contain queue prompts delivered via turn/steer;
        // those are reconciled here together with the manual turn.
        if (bundle.runtime.runner.activeTurnId === event.turnId) return;
        await recordTurn(storage, tabId, { threadId: event.threadId, turn: event.turn, items: event.items, origin: "manual" });
      } catch { /* manual history is reconciled by the explicit sync endpoint */ }
    });
    manager.rpc.on("serverRequest", (request: any) => {
      const requestKey = `${tabId}:${String(request.id)}`;
      pendingApprovals.set(requestKey, { tabId, manager, requestId: request.id });
      emit(tabId, { type: "approval.request", requestKey, request: { method: request.method, params: request.params } });
    });
    manager.rpc.on("threadCompacted", (event: any) => {
      void storage.getTabMeta(tabId).then((tab) => {
        if (codex.existing(tabId) !== manager || !event.threadId || tab.session.threadId !== event.threadId) return;
        // Compaction repaints the native TUI with a large burst. Replaying one
        // authoritative PTY snapshot after that burst cancels any stale xterm
        // write backlog and keeps subsequent terminal deltas on the same offset.
        scheduleCompactionTerminalResync(tabId);
      }).catch(() => undefined);
    });
  });
  codex.on("status", ({ tabId, aggregate }: any) => emit(tabId, { type: "service.changed", codex: aggregate }));
  codex.on("removed", ({ tabId, aggregate }: any) => {
    const resyncTimer = terminalResyncTimers.get(tabId);
    if (resyncTimer) clearTimeout(resyncTimer);
    terminalResyncTimers.delete(tabId);
    for (const [key, pending] of pendingApprovals) if (pending.tabId === tabId) pendingApprovals.delete(key);
    emit(tabId, { type: "service.changed", codex: aggregate });
  });

  const scheduleNativeSessionSwitch = (
    provider: "claude" | "cursor",
    tabId: string,
    manager: ClaudeCodeManager | CursorCliManager,
    session: { sessionId: string; cwd: string; transcriptPath: string | null },
  ): Promise<void> => {
    const previousTask = threadSwitches.get(tabId) ?? Promise.resolve();
    const task = previousTask.catch(() => undefined).then(async () => {
      const currentManager = provider === "claude" ? claude.existing(tabId) : cursor.existing(tabId);
      if (currentManager !== manager) return;
      const tab = await storage.getTabMeta(tabId);
      const fromThreadId = tab.session.threadId;
      if (tab.session.provider !== provider || tab.session.state !== "ready" || !fromThreadId || fromThreadId === session.sessionId) return;

      // SessionStart has already moved the native TUI. Stop any old queue turn
      // before rebinding persistence, then keep pending prompts for the newly
      // selected conversation through the common history reconciliation.
      await runners.get(tabId).freeze().catch(() => undefined);
      const switchedAt = isoNow();
      const workingDirectory = await validWorkingDirectory(session.cwd) ?? tab.session.workingDirectory;
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          ...current.session,
          state: "ready",
          reopenOnLaunch: true,
          workingDirectory,
          threadId: session.sessionId,
          sessionId: session.sessionId,
          connectedAt: switchedAt,
          lastError: null,
          lastThreadSwitch: { fromThreadId, toThreadId: session.sessionId, method: "session/start", switchedAt },
        },
        updatedAt: switchedAt,
      }));
      if (provider === "claude") await syncClaudeHistory(storage, tabId, session.sessionId, session.transcriptPath);
      else await syncCursorHistoryIfAvailable(tabId, session.sessionId, session.transcriptPath);
      await clearSessionNotReadyError(storage, tabId);
      emit(tabId, { type: "thread.switched", switch: { fromThreadId, toThreadId: session.sessionId, method: "session/start", switchedAt } });
        emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true);
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: { ...current.session, lastError: { code: "TERMINAL_THREAD_SYNC_FAILED", message } },
          updatedAt: isoNow(),
        }));
      } catch { /* tab may have been deleted */ }
      emit(tabId, { type: "error", error: { code: "TERMINAL_THREAD_SYNC_FAILED", message } });
      try { emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true); } catch { /* deleted */ }
    });
    threadSwitches.set(tabId, task);
    void task.finally(() => {
      if (threadSwitches.get(tabId) === task) threadSwitches.delete(tabId);
    });
    return task;
  };

  claude.on("created", ({ tabId, manager }: { tabId: string; manager: ClaudeCodeManager }) => {
    manager.on("session", (session) => void scheduleNativeSessionSwitch("claude", tabId, manager, session));
    manager.on("turnCompleted", async (event: any) => {
      try {
        const tab = await storage.getTabMeta(tabId);
        if (tab.session.provider !== "claude" || tab.session.threadId !== event.threadId) return;
        const bundle = await storage.readTab(tabId);
        // Queue turns are finalized by QueueRunner after waitForTurn resolves.
        if (bundle.runtime.runner.activeTurnId === event.turnId) return;
        await recordTurn(storage, tabId, {
          threadId: event.threadId,
          turn: event.turn,
          items: event.items,
          origin: "manual",
        });
      } catch { /* explicit history sync can reconstruct the transcript later */ }
    });
  });

  cursor.on("created", ({ tabId, manager }: { tabId: string; manager: CursorCliManager }) => {
    manager.on("session", (session) => void scheduleNativeSessionSwitch("cursor", tabId, manager, session));
    manager.on("turnCompleted", async (event: any) => {
      try {
        const tab = await storage.getTabMeta(tabId);
        if (tab.session.provider !== "cursor" || tab.session.threadId !== event.threadId) return;
        const bundle = await storage.readTab(tabId);
        if (bundle.runtime.runner.activeTurnId === event.turnId) return;
        await recordTurn(storage, tabId, { threadId: event.threadId, turn: event.turn, items: event.items, origin: "manual" });
      } catch { /* explicit history sync can reconstruct the transcript later */ }
    });
  });

  const emitSnapshot = async (tabId: string): Promise<void> => {
    try { emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true); }
    catch { /* the tab may have been deleted while a restore was finishing */ }
  };

  const claudeHookUrl = (tabId: string): string => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : Number(process.env.PORT ?? 4317);
    return `http://127.0.0.1:${port}/hooks/claude/${encodeURIComponent(tabId)}?token=${encodeURIComponent(token)}`;
  };

  const cursorHookUrl = (tabId: string): string => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : Number(process.env.PORT ?? 4317);
    return `http://127.0.0.1:${port}/hooks/cursor/${encodeURIComponent(tabId)}?token=${encodeURIComponent(token)}`;
  };

  const startClaudeTui = async (
    tabId: string,
    cwd: string,
    launch: { mode: "new" } | { mode: "resume"; sessionId: string },
  ) => {
    const availability = await claudeVersion;
    if (!availability.available) throw new Error("CLAUDE_CLI_NOT_FOUND");
    const manager = claude.get(tabId);
    const theme = (await storage.readIndex()).ui.theme;
    const settingsPath = path.join(storage.tabDir(tabId), "cache", "claude-hooks.settings.json");
    const hookScriptPath = path.join(rootDir, "scripts", "claude-hook.mjs");
    const command = await manager.beginLaunch({ cwd, launch, hookScriptPath, settingsPath, theme });
    await restoreTerminalSize(storage, pty, tabId);
    await pty.startCommand(tabId, cwd, command, "Claude Code", CLAUDE_EXIT_MARKER, {
      CODEX_PROMPTOR_CLAUDE_HOOK_URL: claudeHookUrl(tabId),
    }, theme);
    const session = await manager.waitForSession(30_000, () => pty.startupError(tabId));
    if (launch.mode === "resume" && session.sessionId !== launch.sessionId) {
      throw new Error(`CLAUDE_RESUME_ID_MISMATCH:${launch.sessionId}:${session.sessionId}`);
    }
    return { manager, session };
  };

  const startCursorTui = async (
    tabId: string,
    cwd: string,
    launch: { mode: "new" } | { mode: "resume"; sessionId: string },
  ) => {
    const availability = await cursorVersion;
    if (!availability.available) throw new Error("CURSOR_CLI_NOT_FOUND");
    await ensureCursorHookBridge(rootDir, storage.backupsDir);
    const manager = cursor.get(tabId);
    manager.beginLaunch(cwd);
    const theme = (await storage.readIndex()).ui.theme;
    await restoreTerminalSize(storage, pty, tabId);
    await pty.startCommand(
      tabId,
      cwd,
      buildCursorCommand(cwd, launch, theme),
      "Cursor CLI",
      CURSOR_EXIT_MARKER,
      { CODEX_PROMPTOR_CURSOR_HOOK_URL: cursorHookUrl(tabId) },
      theme,
    );
    const session = await manager.waitForSession(30_000, () => pty.startupError(tabId));
    if (launch.mode === "resume" && session.sessionId !== launch.sessionId) {
      throw new Error(`CURSOR_RESUME_ID_MISMATCH:${launch.sessionId}:${session.sessionId}`);
    }
    return { manager, session };
  };

  const syncCursorHistoryIfAvailable = async (tabId: string, sessionId: string, transcriptPath?: string | null) => {
    try { return (await syncCursorHistory(storage, tabId, sessionId, transcriptPath)).report; }
    catch (error) {
      if (error instanceof Error && error.message.startsWith("CURSOR_TRANSCRIPT_NOT_FOUND:")) {
        return { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
      }
      throw error;
    }
  };

  const performClaudeTerminalReopen = async (tab: TabMeta): Promise<TerminalReopenResult> => {
    const tabId = tab.id;
    try {
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await cursor.stop(tabId);
      await claude.stop(tabId);
      await tuiProxy.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "connecting", lastError: null },
        updatedAt: now,
      }));
      await emitSnapshot(tabId);
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
      const { manager, session } = await startClaudeTui(tabId, tab.session.workingDirectory, { mode: "resume", sessionId: tab.session.threadId });
      await syncClaudeHistory(storage, tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath);
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          ...current.session,
          provider: "claude",
          state: "ready",
          reopenOnLaunch: true,
          threadId: session.sessionId,
          sessionId: session.sessionId,
          connectedAt: isoNow(),
          lastError: null,
        },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      const bundle = await readClientTab(tabId);
      emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true);
      return { ok: true, bundle };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pty.stop(tabId, false).catch(() => undefined);
      await claude.stop(tabId).catch(() => undefined);
      await updateTerminalRuntime(storage, tabId, { state: "stopped", appServer: null }).catch(() => undefined);
      try {
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: { ...current.session, state: "closed", lastError: { code: "TERMINAL_REOPEN_FAILED", message } },
          updatedAt: isoNow(),
        }));
      } catch { /* a missing tab is already effectively closed */ }
      await emitSnapshot(tabId);
      return { ok: false, statusCode: 500, code: "TERMINAL_REOPEN_FAILED", message };
    }
  };

  const performCursorTerminalReopen = async (tab: TabMeta): Promise<TerminalReopenResult> => {
    const tabId = tab.id;
    try {
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await cursor.stop(tabId);
      await claude.stop(tabId);
      await tuiProxy.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({ ...current, session: { ...current.session, state: "connecting", lastError: null }, updatedAt: now }));
      await emitSnapshot(tabId);
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
      const { manager, session } = await startCursorTui(tabId, tab.session.workingDirectory, { mode: "resume", sessionId: tab.session.threadId });
      await syncCursorHistoryIfAvailable(tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath);
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, provider: "cursor", state: "ready", reopenOnLaunch: true, threadId: session.sessionId, sessionId: session.sessionId, connectedAt: isoNow(), lastError: null },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      const bundle = await readClientTab(tabId);
      emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true);
      return { ok: true, bundle };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pty.stop(tabId, false).catch(() => undefined);
      await cursor.stop(tabId).catch(() => undefined);
      await updateTerminalRuntime(storage, tabId, { state: "stopped", appServer: null }).catch(() => undefined);
      try {
        await storage.updateTab(tabId, (current) => ({ ...current, session: { ...current.session, state: "closed", lastError: { code: "TERMINAL_REOPEN_FAILED", message } }, updatedAt: isoNow() }));
      } catch { /* missing tab */ }
      await emitSnapshot(tabId);
      return { ok: false, statusCode: 500, code: "TERMINAL_REOPEN_FAILED", message };
    }
  };

  // Reopening a terminal is just a fresh PowerShell in the same directory:
  // there is no thread to resume, no App Server to wait for, no history to
  // reconcile. It keeps its working directory, which is its whole identity.
  const performShellTerminalReopen = async (tab: TabMeta): Promise<TerminalReopenResult> => {
    const cwd = tab.session.workingDirectory;
    if (!cwd) return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This terminal has no working directory." };
    await pty.stop(tab.id, false);
    const now = isoNow();
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, state: "connecting", lastError: null },
      updatedAt: now,
    }));
    await emitSnapshot(tab.id);
    await updateTerminalRuntime(storage, tab.id, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
    await restoreTerminalSize(storage, pty, tab.id);
    await pty.startShell(tab.id, cwd, (await storage.readIndex()).ui.theme);
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, state: "ready", reopenOnLaunch: true, connectedAt: isoNow(), lastError: null },
      updatedAt: isoNow(),
    }));
    await clearSessionNotReadyError(storage, tab.id);
    return { ok: true, bundle: await readClientTab(tab.id) };
  };

  const performTerminalReopen = async (tabId: string): Promise<TerminalReopenResult> => {
    try {
      await awaitThreadSwitch(tabId);
      const tab = await storage.getTabMeta(tabId);
      if (tab.session.provider === "claude") return performClaudeTerminalReopen(tab);
      if (tab.session.provider === "cursor") return performCursorTerminalReopen(tab);
      if (tab.session.provider === "shell") return performShellTerminalReopen(tab);
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await tuiProxy.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "connecting", lastError: null },
        updatedAt: now,
      }));
      await emitSnapshot(tabId);
      const manager = codex.get(tabId);
      const rpc = await manager.ensureReady();
      await rememberAppServer(storage, tabId, manager);
      const theme = (await storage.readIndex()).ui.theme;
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null });
      const tuiUrl = await startTuiProxy(tabId, manager);
      await restoreTerminalSize(storage, pty, tabId);
      await pty.start(tabId, tab.session.workingDirectory, tuiUrl, { mode: "resume", threadId: tab.session.threadId }, theme);
      await waitForThreadLoaded(rpc, tab.session.threadId, 30_000, 200, () => pty.startupError(tabId));
      await rpc.resumeThread(tab.session.threadId, tab.session.workingDirectory);
      await syncHistory(storage, tabId, await withCodexRolloutTurns(historyThreadFromResponse(await rpc.readThread(tab.session.threadId)), tab.session.threadId));
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", reopenOnLaunch: true, connectedAt: isoNow(), lastError: null },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      // A non-empty Codex input buffer avoids the empty-input cursor repaint
      // loop seen in the remote TUI. This draft space is never submitted and
      // queue prompts continue to use App Server turn/start or turn/steer.
      pty.primeCodexInput(tabId);
      const bundle = await readClientTab(tabId);
      emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true);
      return { ok: true, bundle };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pty.stop(tabId, false).catch(() => undefined);
      await tuiProxy.stop(tabId).catch(() => undefined);
      await stopAppServer(storage, codex, tabId).catch(() => undefined);
      await updateTerminalRuntime(storage, tabId, { state: "stopped" }).catch(() => undefined);
      const activeWriter = isActiveWriterError(message);
      const code = activeWriter ? "SESSION_ACTIVE_WRITER" : "TERMINAL_REOPEN_FAILED";
      const display = activeWriter ? "该 session 正由外部 Codex 占用；请先退出外部 CLI 后重试。" : message;
      try {
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: { ...current.session, state: "closed", lastError: { code, message: display } },
          updatedAt: isoNow(),
        }));
      } catch { /* a missing tab is already effectively closed */ }
      await emitSnapshot(tabId);
      return { ok: false, statusCode: activeWriter ? 409 : 500, code, message: display };
    }
  };

  const reopenTasks = new Map<string, Promise<TerminalReopenResult>>();
  const reopenTerminal = (tabId: string): Promise<TerminalReopenResult> => {
    const existing = reopenTasks.get(tabId);
    if (existing) return existing;
    const task = performTerminalReopen(tabId);
    reopenTasks.set(tabId, task);
    void task.then(() => {
      if (reopenTasks.get(tabId) === task) reopenTasks.delete(tabId);
    });
    return task;
  };

  let restoreOpenSessionsPromise: Promise<RestoreOpenSessionsSummary> | null = null;
  const restoreOpenSessions = (): Promise<RestoreOpenSessionsSummary> => {
    if (restoreOpenSessionsPromise) return restoreOpenSessionsPromise;
    restoreOpenSessionsPromise = Promise.all(startupOpenTabIds.map(async (tabId) => ({ tabId, result: await reopenTerminal(tabId) })))
      .then((results) => ({
        restored: results.filter((item) => item.result.ok).map((item) => item.tabId),
        failed: results.flatMap((item) => item.result.ok ? [] : [{ tabId: item.tabId, code: item.result.code, message: item.result.message }]),
      }));
    return restoreOpenSessionsPromise;
  };

  // Sealed buckets are appended once a minute, off the hot path. `unref` so a
  // measurement timer never keeps the process alive on its own.
  const flushTraffic = async (): Promise<void> => {
    if (!trafficLoggingEnabled) return;
    await trafficLog.append(ledger.drain());
  };
  const trafficFlushTimer = trafficLoggingEnabled
    ? setInterval(() => { void flushTraffic(); }, 60_000)
    : null;
  trafficFlushTimer?.unref?.();
  const trafficPruneTimer = trafficLoggingEnabled
    ? setInterval(() => { void trafficLog.prune(); }, 6 * 60 * 60 * 1_000)
    : null;
  trafficPruneTimer?.unref?.();
  if (trafficLoggingEnabled) void trafficLog.prune();

  app.promptor = { storage, codex, claude, cursor, pty, runners, ui, traffic, documents, token, restoreOpenSessions, close: async () => {
    if (trafficFlushTimer) clearInterval(trafficFlushTimer);
    if (trafficPruneTimer) clearInterval(trafficPruneTimer);
    // Seal the minute in progress so a restart does not lose it.
    await trafficLog.append(ledger.drain(Date.now() + 60_000)).catch(() => undefined);
    ui.stop();
    rawBatcher.close(false);
    projectionScheduler.close();
    for (const timer of terminalResyncTimers.values()) clearTimeout(timer);
    terminalResyncTimers.clear();
    await directoryPicker.stop();
    if (restoreOpenSessionsPromise) await Promise.allSettled([restoreOpenSessionsPromise]);
    await Promise.allSettled([...reopenTasks.values()]);
    await Promise.allSettled([...threadSwitches.values()]);
    await recordOpenSessionsForNextLaunch(storage);
    await runners.stopAll();
    await pty.stopAll();
    await tuiProxy.stopAll();
    await cursor.stopAll();
    await claude.stopAll();
    await codex.stopAll();
  } };

  const apiAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (noAuth) return;
    const header = request.headers["x-codex-promptor-token"];
    const query = (request.query as any)?.token;
    if (header !== token && query !== token && !isTrustedBrowserRequest(request.headers, trustedHosts)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Open http://127.0.0.1:4317/ in the local browser." } });
    }
  };

  const payloadBytes = (payload: unknown): number | null => {
    if (payload === null || payload === undefined) return 0;
    if (typeof payload === "string") return Buffer.byteLength(payload, "utf8");
    if (Buffer.isBuffer(payload)) return payload.length;
    // A stream (a static asset) has no length to read here without consuming
    // it; the socket delta below still measures it.
    return null;
  };

  /**
   * Roughly what the status line and headers cost. A 304 has no body at all,
   * so without this it would look free -- and the saving it represents would
   * be overstated every time it is compared against the 200 it replaced.
   */
  const headerBytes = (reply: FastifyReply): number => {
    let total = 16; // "HTTP/1.1 200 OK\r\n" and the blank line that ends the block
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      total += name.length + 4;
      total += Array.isArray(value) ? value.join(", ").length : String(value ?? "").length;
    }
    return total;
  };

  // Measured on the socket rather than from the payload, because the payload
  // this hook chain sees is the one *before* @fastify/compress rewrites it:
  // plugin hooks are added when the plugin loads, not when register() is
  // called, so hook order cannot be relied on to see the compressed bytes.
  app.addHook("onRequest", async (request) => {
    (request as any).trafficSocketStart = Number((request.raw.socket as any)?.bytesWritten ?? Number.NaN);
  });

  app.addHook("onSend", async (request, _reply, payload) => {
    (request as any).trafficRawBytes = payloadBytes(payload);
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    if (!trafficLoggingEnabled) return;
    const route = request.routeOptions?.url ?? request.url.split("?")[0];
    const start = (request as any).trafficSocketStart;
    const written = Number((request.raw.socket as any)?.bytesWritten ?? Number.NaN);
    const raw = (request as any).trafficRawBytes;
    const body = typeof raw === "number" ? raw : 0;
    // The socket delta is the truth when it is available: it counts headers,
    // compression and chunk framing. `inject()` has no real socket, so fall
    // back to headers plus the uncompressed body.
    const delta = Number.isFinite(start) && Number.isFinite(written) ? written - start : Number.NaN;
    const wire = Number.isFinite(delta) && delta > 0 ? delta : headerBytes(reply) + body;
    recordTraffic("out", "http", `${request.method} ${route} ${reply.statusCode}`, wire, headerBytes(reply) + body);

    const requestBytes = Number(request.headers["content-length"]);
    if (Number.isFinite(requestBytes) && requestBytes > 0) {
      recordTraffic("in", "http", `${request.method} ${route}`, requestBytes);
    }
  });

  await app.register(fastifyCompress, {
    global: true,
    globalDecompression: false,
    threshold: 512,
    encodings: ["br", "gzip"],
  });
  await app.register(fastifyStatic, {
    root: path.join(rootDir, "dist", "client"),
    prefix: "/",
    decorateReply: false,
    // Resolve hashed Vite assets when they are requested. With wildcard=false,
    // @fastify/static snapshots the directory at startup, so rebuilding the
    // client while the service is open leaves index.html pointing at a JS file
    // for which no route exists until the whole service is restarted.
    wildcard: true,
    index: "index.html",
  });
  const websocketCompression = process.env.CODEX_PROMPTOR_WS_COMPRESSION !== "0";
  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: Math.ceil(transportConfig.maxInputMessageBytes / 3) * 4 + 16 * 1024,
      perMessageDeflate: websocketCompression ? {
        serverNoContextTakeover: true,
        clientNoContextTakeover: true,
        concurrencyLimit: 4,
        threshold: 1024,
        zlibDeflateOptions: { level: 3, memLevel: 7 },
      } : false,
    },
  });

  // Claude Code invokes these hooks from the local TUI process. The per-launch
  // URL carries Promptor's random local token; this route intentionally lives
  // outside /api so it is not subject to browser-origin authentication.
  app.post("/hooks/claude/:tabId", async (request, reply) => {
    if ((request.query as any)?.token !== token) return reply.code(401).send();
    const tabId = String((request.params as any).tabId);
    const manager = claude.existing(tabId);
    if (!manager) return reply.code(410).send();
    try {
      await manager.handleHook(request.body ?? {});
      return reply.code(204).send();
    } catch (error) {
      emit(tabId, { type: "error", error: { code: "CLAUDE_HOOK_FAILED", message: error instanceof Error ? error.message : String(error) } });
      return reply.code(400).send();
    }
  });

  app.post("/hooks/cursor/:tabId", async (request, reply) => {
    if ((request.query as any)?.token !== token) return reply.code(401).send();
    const tabId = String((request.params as any).tabId);
    const manager = cursor.existing(tabId);
    if (!manager) return reply.code(410).send();
    try {
      const output = await manager.handleHook(request.body ?? {});
      return reply.send(output);
    } catch (error) {
      emit(tabId, { type: "error", error: { code: "CURSOR_HOOK_FAILED", message: error instanceof Error ? error.message : String(error) } });
      return reply.code(400).send({});
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) await apiAuth(request, reply);
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/documents/") && reply.statusCode >= 400) reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.get("/api/health", async (_request, reply) => reply.send({ data: { ok: true, codex: codex.status, claude: await claudeVersion, cursor: await cursorVersion } }));

  app.post("/api/documents/open", { bodyLimit: 12 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const data = await documents.open(request.body as any);
      return reply.send({ data });
    } catch (error) { return sendDocumentError(reply, error); }
  });

  app.post("/api/documents/open-local", { bodyLimit: 12 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!isLocalBrowserRequest(request.headers)) {
      return sendDocumentError(reply, new DocumentError(403, "DOCUMENT_LOCAL_ONLY", "Opening a desktop application is allowed only from a loopback browser."));
    }
    try {
      const data = await documents.openLocal(request.body as any);
      return reply.send({ data });
    } catch (error) { return sendDocumentError(reply, error); }
  });

  app.get("/api/documents/:docId/chunks/:index", async (request, reply) => {
    try {
      const params = request.params as { docId?: unknown; index?: unknown };
      const query = request.query as { rev?: unknown };
      const rawIndex = String(params.index ?? "");
      if (!/^(?:0|[1-9]\d{0,7})$/.test(rawIndex)) throw new DocumentError(400, "DOCUMENT_CHUNK_OUT_OF_RANGE", "The document chunk index is invalid.");
      const chunk = await documents.readChunk(String(params.docId ?? ""), String(query.rev ?? ""), Number(rawIndex));
      reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("ETag", `W/\"${chunk.docId}.${chunk.revision}.${chunk.index}\"`)
        .header("Vary", "x-codex-promptor-token, accept-encoding");
      return reply.send(chunk.bytes);
    } catch (error) {
      reply.header("Cache-Control", "no-store");
      return sendDocumentError(reply, error);
    }
  });

  app.get("/api/diagnostics/terminal-traffic", async (_request, reply) => reply.send({ data: traffic.snapshot() }));

  /**
   * What this service spent bytes on, by kind.
   *
   * `?hours=` selects the window (default 24, max 720). `?buckets=1` adds the
   * per-minute series behind the rollup for plotting. Anything older than the
   * in-memory window is read from the daily files, so a week-old question is
   * still answerable after restarts.
   */
  app.get("/api/diagnostics/traffic", async (request, reply) => {
    const query = (request.query ?? {}) as any;
    const hours = boundedInteger(query.hours, 1, 720, 24);
    const sinceMs = hours * 60 * 60 * 1_000;
    const now = Date.now();
    const stored = await trafficLog.read(sinceMs, now);
    const live = ledger.buckets();
    // A bucket can be in both places: it was appended a minute ago and is
    // still inside the memory window. Later wins, and both copies are equal.
    const byStart = new Map(stored.map((bucket) => [bucket.startedAt, bucket]));
    for (const bucket of live) byStart.set(bucket.startedAt, bucket);
    const merged = [...byStart.values()]
      .filter((bucket) => Date.parse(bucket.startedAt) >= now - sinceMs)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return reply.send({ data: {
      enabled: trafficLoggingEnabled,
      window: { hours, buckets: merged.length },
      rollup: rollupBuckets(merged),
      ...(query.buckets === "1" ? { buckets: merged } : {}),
    } });
  });

  app.post("/api/diagnostics/traffic/reset", async (_request, reply) => {
    ledger.reset();
    await trafficLog.clear();
    return reply.send({ data: { cleared: true } });
  });

  app.post("/api/diagnostics/terminal-traffic/reset", async (_request, reply) => {
    traffic.reset();
    return reply.send({ data: traffic.snapshot() });
  });

  app.get("/api/bootstrap", async (_request, reply) => {
    const index = await storage.readIndex();
    const activities: Record<string, TabActivitySummary> = {};
    await Promise.all(index.tabs.map(async (tab) => {
      try { activities[tab.id] = await storage.readTabActivity(tab.id); }
      catch { /* a concurrently deleted or incomplete tab is omitted */ }
    }));
    return reply.send({ data: {
      index,
      activities,
      app: {
        version: "0.1.0",
        codex: codex.status,
        claude: await claudeVersion,
        cursor: await cursorVersion,
        protocol: "multi-provider",
        terminal: {
          protocolVersion: TERMINAL_PROTOCOL_VERSION,
          modes: ["raw", "projection"],
          compression: websocketCompression,
          rawBatchIdleMs: transportConfig.rawBatchIdleMs,
          rawBatchInteractiveMs: transportConfig.rawBatchInteractiveMs,
          interactiveOutputMaxBytes: transportConfig.interactiveOutputMaxBytes,
          projection: {
            defaultViewportRows: defaultProjectionSchedulerConfig.defaultViewportRows,
            defaultFps: defaultProjectionSchedulerConfig.defaultFps,
            maxViewportRows: 60,
            maxFps: 5,
            bytesPerSecond: transportConfig.projectionBytesPerSecond,
            maxBurstBytes: transportConfig.projectionMaxBurstBytes,
          },
        },
      },
    } });
  });

  app.patch("/api/preferences", async (request, reply) => {
    const body = (request.body ?? {}) as any;
    try {
      const index = await storage.updateIndex((current) => ({
        ...current,
        ui: {
          ...current.ui,
          ...(body.consoleWidth !== undefined ? { consoleWidth: Math.max(220, Math.min(520, Number(body.consoleWidth))) } : {}),
          ...(body.theme === "light" || body.theme === "dark" ? { theme: body.theme } : {}),
          ...(body.locale === "zh-CN" || body.locale === "en" ? { locale: body.locale } : {}),
          ...(body.ungroupedCollapsed !== undefined ? { ungroupedCollapsed: Boolean(body.ungroupedCollapsed) } : {}),
        },
      }));
      if (body.theme === "light" || body.theme === "dark") {
        for (const tab of index.tabs) pty.setScreenTheme(tab.id, body.theme);
      }
      return reply.send({ data: index });
    } catch (error) { return apiError(reply, 400, "PREFERENCES_INVALID", error instanceof Error ? error.message : String(error)); }
  });

  app.put("/api/navigation/order", async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const groupIds = Array.isArray(body.groupIds) ? body.groupIds.map(String) : [];
    const sections = Array.isArray(body.sections) ? body.sections.map((section: any) => ({
      groupId: section?.groupId === null ? null : String(section?.groupId ?? ""),
      tabIds: Array.isArray(section?.tabIds) ? section.tabIds.map(String) : [],
    })) : [];
    try {
      const index = await storage.updateIndex((current) => applyNavigationOrder(current, groupIds, sections));
      await Promise.all(index.tabs.map((tab) => storage.writeTab(tab)));
      return reply.send({ data: index });
    } catch (error) { return apiError(reply, 400, "NAVIGATION_ORDER_INVALID", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/dialog/select-directory", async (request, reply) => {
    if (process.platform !== "win32") return reply.code(400).send({ error: { code: "WINDOWS_ONLY", message: "Folder dialog is available on Windows." } });
    const body = (request.body ?? {}) as any;
    const initialPath = await validWorkingDirectory(body.initialPath)
      ?? await validWorkingDirectory(process.env.USERPROFILE)
      ?? process.cwd();
    try {
      return reply.send({ data: { path: await directoryPicker.select(initialPath) } });
    } catch (error) {
      if (error instanceof DirectoryPickerBusyError) return apiError(reply, 409, "DIRECTORY_DIALOG_BUSY", "文件夹选择窗口已经打开，请先完成或取消当前选择。");
      return reply.code(500).send({ error: { code: "DIRECTORY_DIALOG_FAILED", message: error instanceof Error ? error.message : String(error) } });
    }
  });

  app.post("/api/groups", async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const name = String(body.name ?? "新分组").trim().slice(0, 80) || "新分组";
    const index = await storage.readIndex();
    const group: Group = { id: randomUUID(), name, order: index.groups.length, collapsed: false };
    const next = await storage.updateIndex((current) => ({ ...current, groups: [...current.groups, group] }));
    return reply.send({ data: { group, index: next } });
  });

  app.patch("/api/groups/:groupId", async (request, reply) => {
    const groupId = String((request.params as any).groupId);
    const body = (request.body ?? {}) as any;
    const index = await storage.readIndex();
    if (!index.groups.some((item) => item.id === groupId)) return apiError(reply, 404, "GROUP_NOT_FOUND", "Group not found.");
    const next = await storage.updateIndex((current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? {
        ...group,
        ...(body.name !== undefined ? { name: String(body.name).trim().slice(0, 80) } : {}),
        ...(body.collapsed !== undefined ? { collapsed: Boolean(body.collapsed) } : {}),
        ...(body.order !== undefined ? { order: Number(body.order) } : {}),
      } : group),
    }));
    return reply.send({ data: next });
  });

  app.delete("/api/groups/:groupId", async (request, reply) => {
    const groupId = String((request.params as any).groupId);
    try {
      const previous = await storage.readIndex();
      const movedIds = new Set(previous.tabs.filter((tab) => tab.groupId === groupId).map((tab) => tab.id));
      const next = await storage.updateIndex((current) => deleteGroupAndUngroupTabs(current, groupId));
      await Promise.all(next.tabs.filter((tab) => movedIds.has(tab.id)).map((tab) => storage.writeTab(tab)));
      return reply.send({ data: next });
    } catch (error) { return apiError(reply, 404, "GROUP_NOT_FOUND", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/tabs", async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const tab = await storage.createTab(String(body.name ?? "未命名对话").trim().slice(0, 100) || "未命名对话");
    return reply.send({ data: tab });
  });

  app.patch("/api/tabs/:tabId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const body = (request.body ?? {}) as any;
    try {
      const tab = await storage.updateTab(tabId, (current) => ({
        ...current,
        ...(body.name !== undefined ? { name: String(body.name).trim().slice(0, 100) || current.name } : {}),
        ...(body.groupId !== undefined ? { groupId: body.groupId === null ? null : String(body.groupId) } : {}),
        ...(body.order !== undefined ? { order: Number(body.order) } : {}),
        ...(body.layout?.leftWidthPercent !== undefined ? { layout: { leftWidthPercent: Math.max(20, Math.min(80, Number(body.layout.leftWidthPercent))) } } : {}),
        updatedAt: isoNow(),
      }));
      return reply.send({ data: tab });
    } catch (error) { return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error)); }
  });

  app.delete("/api/tabs/:tabId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    await awaitThreadSwitch(tabId);
    // The tab directory is moved immediately below; do not enqueue a terminal
    // runtime write that can race the directory rename on Windows.
    await pty.stop(tabId, false);
    pty.forget(tabId);
    await tuiProxy.stop(tabId);
    await runners.remove(tabId);
    await cursor.stop(tabId);
    await claude.stop(tabId);
    await stopAppServer(storage, codex, tabId);
    try { await storage.deleteTab(tabId); } catch (error) { return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error)); }
    return reply.send({ data: { deleted: true } });
  });

  app.get("/api/tabs/:tabId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const query = (request.query ?? {}) as any;
    const promptLimit = boundedInteger(query.promptLimit, 1, MAX_WINDOW_RECORDS, INITIAL_PROMPT_WINDOW);
    const answerLimit = boundedInteger(query.answerLimit, 1, MAX_WINDOW_RECORDS, INITIAL_ANSWER_WINDOW);
    try { return sendRevalidatable(request, reply, await storage.readTabWindow(tabId, promptLimit, answerLimit)); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      return missing
        ? apiError(reply, 404, "TAB_NOT_FOUND", message)
        : apiError(reply, 503, "TAB_READ_FAILED", message, true);
    }
  });

  app.get("/api/tabs/:tabId/prompts/page", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const query = (request.query ?? {}) as any;
    try {
      return sendRevalidatable(request, reply, await storage.readPromptPage(tabId, Number(query.before), boundedInteger(query.limit, 1, MAX_WINDOW_RECORDS, EARLIER_PROMPT_PAGE)));
    } catch (error) {
      return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/api/tabs/:tabId/answers/page", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const query = (request.query ?? {}) as any;
    try {
      return sendRevalidatable(request, reply, await storage.readAnswerPage(tabId, Number(query.before), boundedInteger(query.limit, 1, MAX_WINDOW_RECORDS, EARLIER_ANSWER_PAGE)));
    } catch (error) {
      return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/tabs/:tabId/session", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const body = (request.body ?? {}) as any;
    const parsedProvider = AgentProviderSchema.safeParse(body.provider ?? "codex");
    if (!parsedProvider.success) return apiError(reply, 400, "INVALID_PROVIDER", "Choose Codex, Claude Code, Cursor CLI, or Terminal.");
    const provider: AgentProvider = parsedProvider.data;
    const mode = body.mode === "resume" ? "resume" : "new";
    // An agent session always needs a real project directory. A terminal does
    // not: leaving the path empty is a request for the default one, resolved
    // the same way the folder picker resolves its starting directory.
    const cwd = provider === "shell"
      ? (await validWorkingDirectory(body.workingDirectory ?? body.cwd)
        ?? await validWorkingDirectory(process.env.USERPROFILE)
        ?? process.cwd())
      : await validWorkingDirectory(body.workingDirectory ?? body.cwd);
    if (!cwd) return apiError(reply, 400, "INVALID_WORKING_DIRECTORY", "Choose an existing local directory.");
    const resumeId = mode === "resume" ? String(body.resumeId ?? "") : "";
    if (mode === "resume" && !isValidResumeId(provider, resumeId)) {
      const code = provider === "cursor" ? "INVALID_CURSOR_RESUME_ID" : "INVALID_RESUME_ID";
      const message = provider === "cursor"
        ? "Cursor chat id is required and cannot contain control characters."
        : "Session id must be a UUID.";
      return apiError(reply, 400, code, message);
    }
    const previous = await storage.getTabMeta(tabId).catch(() => null);
    if (previous?.session.threadId && previous.session.provider !== provider) {
      return apiError(reply, 409, "PROVIDER_IMMUTABLE", "A connected tab keeps its original provider. Create a new tab to switch providers.");
    }
    try {
      await awaitThreadSwitch(tabId);
      await pty.stop(tabId, false);
      await tuiProxy.stop(tabId);
      await cursor.stop(tabId);
      await claude.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      await storage.updateTab(tabId, (tab) => ({ ...tab, session: { ...tab.session, provider, state: "connecting", lastError: null }, updatedAt: isoNow() }));
      if (provider === "shell") {
        const now = isoNow();
        await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
        await restoreTerminalSize(storage, pty, tabId);
        await pty.startShell(tabId, cwd, (await storage.readIndex()).ui.theme);
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: {
            ...current.session,
            provider: "shell",
            state: "ready",
            reopenOnLaunch: true,
            workingDirectory: cwd,
            // No agent means no thread and no session id. Everything keyed off
            // them -- the queue runner, history sync -- stays switched off.
            threadId: null,
            sessionId: null,
            createdAt: current.session.createdAt ?? now,
            connectedAt: isoNow(),
            lastError: null,
            lastThreadSwitch: null,
          },
          updatedAt: isoNow(),
        }));
        await clearSessionNotReadyError(storage, tabId);
        return reply.send({ data: { bundle: await readClientTab(tabId), report: { imported: 0, skipped: 0, ignored: 0, repaired: 0 } } });
      }
      if (provider === "claude") {
        const now = isoNow();
        await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
        const { manager, session } = await startClaudeTui(
          tabId,
          cwd,
          mode === "resume" ? { mode: "resume", sessionId: resumeId } : { mode: "new" },
        );
        const report = mode === "resume"
          ? (await syncClaudeHistory(storage, tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath)).report
          : { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: {
            provider: "claude",
            state: "ready",
            reopenOnLaunch: true,
            workingDirectory: cwd,
            threadId: session.sessionId,
            sessionId: session.sessionId,
            createdAt: current.session.createdAt ?? now,
            connectedAt: isoNow(),
            lastError: null,
            lastThreadSwitch: null,
          },
          updatedAt: isoNow(),
        }));
        await clearSessionNotReadyError(storage, tabId);
        return reply.send({ data: { bundle: await readClientTab(tabId), report } });
      }
      if (provider === "cursor") {
        const now = isoNow();
        await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
        const { manager, session } = await startCursorTui(
          tabId,
          cwd,
          mode === "resume" ? { mode: "resume", sessionId: resumeId } : { mode: "new" },
        );
        const report = mode === "resume"
          ? await syncCursorHistoryIfAvailable(tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath)
          : { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: {
            provider: "cursor",
            state: "ready",
            reopenOnLaunch: true,
            workingDirectory: cwd,
            threadId: session.sessionId,
            sessionId: session.sessionId,
            createdAt: current.session.createdAt ?? now,
            connectedAt: isoNow(),
            lastError: null,
            lastThreadSwitch: null,
          },
          updatedAt: isoNow(),
        }));
        await clearSessionNotReadyError(storage, tabId);
        return reply.send({ data: { bundle: await readClientTab(tabId), report } });
      }
      let manager = codex.get(tabId);
      let rpc = await manager.ensureReady();
      await rememberAppServer(storage, tabId, manager);
      let thread: any = null;
      let threadId = "";
      let report: unknown = null;
      if (mode === "resume") {
        thread = historyThreadFromResponse(await rpc.readThread(resumeId));
        threadId = String(thread?.id ?? thread?.threadId ?? resumeId);
      }
      if (mode === "resume" && !threadId) throw new Error("THREAD_ID_MISSING");
      // The TUI must make the first thread selection on this App Server. For a
      // new conversation it creates the thread itself; pre-creating an empty
      // thread and restarting App Server leaves no saved rollout for `resume`.
      // For a stored conversation, the TUI remains the first client to resume
      // it, avoiding the false Working state seen when the controller goes first.
      const newThreadGate = mode === "new"
        ? new InitialTuiThreadGate((selection) => scheduleThreadSwitch(tabId, manager, selection))
        : null;
      const now = isoNow();
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null });
      const tuiUrl = await startTuiProxy(
        tabId,
        manager,
        newThreadGate?.observe,
        (error) => newThreadGate?.cancel(error),
      );
      await restoreTerminalSize(storage, pty, tabId);
      await pty.start(
        tabId,
        cwd,
        tuiUrl,
        mode === "new" ? { mode: "new" } : { mode: "resume", threadId },
        (await storage.readIndex()).ui.theme,
      );
      if (newThreadGate) {
        const selection = await newThreadGate.wait(() => pty.startupError(tabId));
        thread = historyThreadFromResponse(selection.thread);
        threadId = String(thread?.id ?? thread?.threadId ?? "");
        if (!threadId) throw new Error("THREAD_ID_MISSING");
        // A fresh legacy thread lives in the App Server before its first turn,
        // but it has no rollout file for thread/read or thread/resume yet. The
        // TUI response is authoritative here; the first queue/manual turn will
        // persist the rollout and make normal history reads available.
        report = { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
      } else {
        await waitForThreadLoaded(rpc, threadId, 30_000, 200, () => pty.startupError(tabId));
        thread = historyThreadFromResponse(await rpc.resumeThread(threadId, cwd));
        report = await syncHistory(storage, tabId, await withCodexRolloutTurns(historyThreadFromResponse(await rpc.readThread(threadId)), threadId));
      }
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          provider: "codex",
          state: "ready",
          reopenOnLaunch: true,
          workingDirectory: cwd,
          threadId,
          sessionId: String(thread?.sessionId ?? threadId),
          createdAt: current.session.createdAt ?? now,
          connectedAt: isoNow(),
          lastError: null,
          lastThreadSwitch: null,
        },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      await newThreadGate?.activate();
      // Prime the real TUI only after its initial thread has been selected, so
      // the space cannot be consumed by the surrounding PowerShell command.
      pty.primeCodexInput(tabId);
      const bundle = await readClientTab(tabId);
      return reply.send({ data: { bundle, report } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pty.stop(tabId, false).catch(() => undefined);
      await tuiProxy.stop(tabId).catch(() => undefined);
      await cursor.stop(tabId).catch(() => undefined);
      await claude.stop(tabId).catch(() => undefined);
      await stopAppServer(storage, codex, tabId).catch(() => undefined);
      await updateTerminalRuntime(storage, tabId, { state: "stopped" }).catch(() => undefined);
      const activeWriter = provider === "codex" && isActiveWriterError(message);
      const unavailable = message === "CLAUDE_CLI_NOT_FOUND" || message === "CURSOR_CLI_NOT_FOUND";
      const code = activeWriter ? "SESSION_ACTIVE_WRITER" : unavailable ? message : "SESSION_CONNECT_FAILED";
      const display = activeWriter ? "该 session 正由另一个 Codex 进程占用；请先退出外部 CLI 或其他客户端后重试。" : message;
      try { await storage.updateTab(tabId, (tab) => ({ ...tab, session: { ...tab.session, state: previous?.session.state === "closed" ? "closed" : "error", lastError: { code, message: display } }, updatedAt: isoNow() })); } catch { /* tab error is secondary */ }
      return apiError(reply, activeWriter ? 409 : unavailable ? 503 : 502, code, display, true);
    }
  });

  app.post("/api/tabs/:tabId/history/sync", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    try {
      await awaitThreadSwitch(tabId);
      const tab = await storage.getTabMeta(tabId);
      if (tab.session.state === "closed") return apiError(reply, 423, "CONVERSATION_CLOSED", "对话已关闭，请先重新打开终端。");
      if (tab.session.provider === "shell") return apiError(reply, 400, "SHELL_HAS_NO_HISTORY", "终端对话没有可同步的历史。");
      if (!tab.session.threadId) return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no session.");
      if (tab.session.provider === "claude") {
        const manager = claude.existing(tabId);
        const result = await syncClaudeHistory(storage, tabId, tab.session.threadId, manager?.session?.transcriptPath);
        return reply.send({ data: { report: result.report, bundle: await readClientTab(tabId) } });
      }
      if (tab.session.provider === "cursor") {
        const manager = cursor.existing(tabId);
        const result = await syncCursorHistory(storage, tabId, tab.session.threadId, manager?.session?.transcriptPath);
        return reply.send({ data: { report: result.report, bundle: await readClientTab(tabId) } });
      }
      const rpc = await codex.get(tabId).ensureReady();
      const thread = await withCodexRolloutTurns(historyThreadFromResponse(await rpc.readThread(tab.session.threadId)), tab.session.threadId);
      const report = await syncHistory(storage, tabId, thread);
      return reply.send({ data: { report, bundle: await readClientTab(tabId) } });
    } catch (error) { return apiError(reply, 502, "HISTORY_SYNC_FAILED", error instanceof Error ? error.message : String(error), true); }
  });

  app.post("/api/tabs/:tabId/terminal/reopen", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const result = await reopenTerminal(tabId);
    if (!result.ok) return apiError(reply, result.statusCode, result.code, result.message, true);
    return reply.send({ data: result.bundle });
  });

  app.post("/api/tabs/:tabId/session/close", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    try {
      await awaitThreadSwitch(tabId);
      const bundle = await storage.readTab(tabId);
      const tab = bundle.tab;
      if (!tab.session.threadId && tab.session.provider !== "shell") return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no active session.");
      await runners.get(tabId).freeze();
      // A terminal reaches this route with no threadId at all, so narrow here
      // rather than leaning on the guard above having ruled null out.
      const codexThreadId = tab.session.provider === "codex" ? tab.session.threadId : null;
      if (codexThreadId) {
        const manager = codex.existing(tabId);
        if (manager) {
          const activeTurns = manager.rpc.activeTurnIds(codexThreadId);
          await Promise.all(activeTurns.map((turnId) => manager.rpc.interruptTurn(codexThreadId, turnId).catch(() => undefined)));
          if (activeTurns.length) await manager.rpc.waitForThreadIdle(codexThreadId, 5_000).catch(() => undefined);
        }
      }
      await pty.stop(tabId);
      await tuiProxy.stop(tabId);
      await cursor.stop(tabId);
      await claude.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", reopenOnLaunch: false, lastError: null },
        updatedAt: now,
      }));
      await updateTerminalRuntime(storage, tabId, { state: "stopped", lastExitCode: null, lastError: null, appServer: null });
      return reply.send({ data: await readClientTab(tabId) });
    } catch (error) { return apiError(reply, 500, "CONVERSATION_CLOSE_FAILED", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/tabs/:tabId/prompts", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const body = (request.body ?? {}) as any;
    const text = String(body.text ?? "").trim();
    if (!text) return apiError(reply, 400, "PROMPT_EMPTY", "Prompt text cannot be empty.");
    try {
      let armed = false;
      let delta: PromptDelta | null = null;
      const prompt = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertQueueUsable(bundle);
        armed = bundle.runtime.runner.desiredState === "armed";
        const next = newPrompt(text, "queue");
        const beforeId = body.beforeId ? String(body.beforeId) : null;
        const afterId = body.afterId ? String(body.afterId) : null;
        const before = beforeId ? bundle.prompts.prompts.findIndex((item) => item.id === beforeId) : -1;
        const after = afterId ? bundle.prompts.prompts.findIndex((item) => item.id === afterId) : -1;
        const index = before >= 0 ? before : after >= 0 ? after + 1 : bundle.prompts.prompts.length;
        bundle.prompts.prompts.splice(index, 0, next);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        delta = await storage.writePrompts(tabId, bundle.prompts);
        return next;
      });
      // An armed queue is idle but waiting to be fed: adding a prompt is the
      // start signal, so the user does not have to add and then press start.
      // A paused queue was stopped deliberately and must stay stopped.
      if (armed) await runners.get(tabId).start().catch(() => undefined);
      return reply.send({ data: { prompt, delta } });
    } catch (error) {
      // A refused queue is not a missing tab; only fall back to 404 once the
      // guard has been ruled out.
      if (error instanceof QueueUnavailableError) return apiError(reply, error.statusCode, error.code, error.message);
      return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error));
    }
  });

  app.patch("/api/tabs/:tabId/prompts/:promptId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const promptId = String((request.params as any).promptId);
    const body = (request.body ?? {}) as any;
    try {
      const { prompt, delta } = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertQueueUsable(bundle);
        const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
        if (!prompt) throw new Error("PROMPT_NOT_FOUND");
        if (["completed", "running", "dispatching"].includes(prompt.status)) throw new Error("PROMPT_READ_ONLY");
        if (body.text !== undefined) {
          const text = String(body.text).trim();
          if (!text) throw new Error("PROMPT_EMPTY");
          prompt.text = text;
        }
        prompt.updatedAt = isoNow();
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        return { prompt, delta: await storage.writePrompts(tabId, bundle.prompts) };
      });
      return reply.send({ data: { prompt, delta } });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return apiError(reply, message.includes("对话已关闭") ? 423 : 400, message.includes("对话已关闭") ? "CONVERSATION_CLOSED" : "PROMPT_UPDATE_FAILED", message); }
  });

  app.delete("/api/tabs/:tabId/prompts/:promptId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const promptId = String((request.params as any).promptId);
    try {
      const delta = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertQueueUsable(bundle);
        const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
        if (!prompt) throw new Error("PROMPT_NOT_FOUND");
        if (["completed", "running", "dispatching"].includes(prompt.status)) throw new Error("PROMPT_READ_ONLY");
        bundle.prompts.prompts = bundle.prompts.prompts.filter((item) => item.id !== promptId);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        return storage.writePrompts(tabId, bundle.prompts);
      });
      return reply.send({ data: { deleted: true, delta } });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return apiError(reply, message.includes("对话已关闭") ? 423 : 400, message.includes("对话已关闭") ? "CONVERSATION_CLOSED" : "PROMPT_DELETE_FAILED", message); }
  });

  /**
   * A drag names the row that moved and the row it landed on. The server holds
   * the authoritative order and derives the new one with the same function the
   * dragging screen used, so nobody ships a list of every queued id -- two ids
   * describe the move whether the queue holds three prompts or three hundred.
   * (`promptIds` stays accepted for a browser tab left open across an upgrade.)
   */
  app.put("/api/tabs/:tabId/prompts/order", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const body = (request.body ?? {}) as any;
    const sourceId = body.sourceId ? String(body.sourceId) : null;
    const targetId = body.targetId ? String(body.targetId) : null;
    const sentIds = Array.isArray(body.promptIds) ? body.promptIds.map(String) : null;
    try {
      const delta = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertQueueUsable(bundle);
        const threadId = bundle.tab.session.threadId;
        const isReorderable = (item: (typeof bundle.prompts.prompts)[number]) => item.status === "pending"
          && (!item.threadId || item.threadId === threadId);
        const pending = bundle.prompts.prompts.filter(isReorderable);
        const pendingIds = pending.map((item) => item.id);
        const nextIds = sourceId && targetId ? reorderPromptIds(pendingIds, sourceId, targetId) : sentIds;
        if (!nextIds
          || nextIds.length !== pending.length
          || new Set(nextIds).size !== nextIds.length
          || nextIds.some((id: string) => !pendingIds.includes(id))) throw new Error("PROMPT_ORDER_INVALID");
        const byId = new Map(pending.map((item) => [item.id, item]));
        let cursor = 0;
        bundle.prompts.prompts = bundle.prompts.prompts.map((item) => isReorderable(item) ? byId.get(nextIds[cursor++])! : item);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        return storage.writePrompts(tabId, bundle.prompts);
      });
      return reply.send({ data: { delta } });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return apiError(reply, message.includes("对话已关闭") ? 423 : 400, message.includes("对话已关闭") ? "CONVERSATION_CLOSED" : "PROMPT_ORDER_INVALID", message); }
  });

  app.post("/api/tabs/:tabId/runner/start", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertQueueUsable(await storage.readTab(tabId)); await runners.get(tabId).start(); return reply.send({ data: { runtime: await storage.readRuntime(tabId) } }); } catch (error) { return apiError(reply, 400, "RUNNER_START_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/runner/pause", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertQueueUsable(await storage.readTab(tabId)); await runners.get(tabId).pause(); return reply.send({ data: { runtime: await storage.readRuntime(tabId) } }); } catch (error) { return apiError(reply, 400, "RUNNER_PAUSE_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/runner/interrupt", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertQueueUsable(await storage.readTab(tabId)); await runners.get(tabId).interruptCurrent(); return reply.send({ data: { runtime: await storage.readRuntime(tabId) } }); } catch (error) { return apiError(reply, 400, "RUNNER_INTERRUPT_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.patch("/api/tabs/:tabId/runner/config", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertQueueUsable(await storage.readTab(tabId)); const value = (request.body as any)?.onFailure; if (value !== "pause" && value !== "continue") throw new Error("onFailure must be pause or continue"); const runtime = await runners.get(tabId).configure(value); return reply.send({ data: runtime }); } catch (error) { return apiError(reply, 400, "RUNNER_CONFIG_INVALID", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/prompts/:promptId/retry", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertQueueUsable(await storage.readTab(tabId)); await runners.get(tabId).retry(String((request.params as any).promptId)); return reply.send({ data: { runtime: await storage.readRuntime(tabId) } }); } catch (error) { return apiError(reply, 400, "PROMPT_RETRY_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/prompts/:promptId/skip", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertQueueUsable(await storage.readTab(tabId)); await runners.get(tabId).skip(String((request.params as any).promptId)); return reply.send({ data: { runtime: await storage.readRuntime(tabId) } }); } catch (error) { return apiError(reply, 400, "PROMPT_SKIP_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/prompts/:promptId/insert-now", async (request, reply) => {
    try {
      const tabId = String((request.params as any).tabId);
      assertQueueUsable(await storage.readTab(tabId));
      const result = await runners.get(tabId).insertNow(String((request.params as any).promptId));
      return reply.send({ data: { ...result, runtime: await storage.readRuntime(tabId) } });
    } catch (error) {
      return apiError(reply, 400, "PROMPT_INSERT_NOW_FAILED", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const queryToken = (request.query as any)?.token;
    if (!noAuth && queryToken !== token && !isTrustedBrowserRequest(request.headers, trustedHosts)) { socket.close(1008, "Unauthorized"); return; }
    const client: Client = {
      id: traffic.register(socket),
      socket,
      stateSubscriptions: new Set(),
      terminalSubscriptions: new Map(),
      wantsIndex: false,
      wantsDetails: true,
    };
    clients.add(client);
    ui.connect();
    socket.on("close", () => {
      if (!clients.delete(client)) return;
      const rawTabs = [...client.terminalSubscriptions.entries()]
        .filter(([, stream]) => stream.mode === "raw")
        .map(([tabId]) => tabId);
      projectionScheduler.unsubscribeClient(client.id);
      for (const tabId of rawTabs) refreshResponderLease(tabId);
      traffic.unregister(client.id);
      ui.disconnect();
    });
    socket.on("message", async (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as any;
        // Inbound was never measured before. It is small per message but
        // keystrokes are frequent, and "frequent and small" is exactly the
        // shape that hides in a total.
        recordTraffic("in", "ws", String(message?.type ?? "unparsed"), raw.length);
        if (message.type === "subscribe") {
          const previousRawTabs = [...client.terminalSubscriptions.entries()]
            .filter(([, stream]) => stream.mode === "raw")
            .map(([tabId]) => tabId);
          projectionScheduler.unsubscribeClient(client.id);
          client.stateSubscriptions = parseTabSubscriptions(message.tabIds);
          client.terminalSubscriptions = parseTerminalSubscriptions(message.terminals);
          client.wantsIndex = message.index === true;
          client.wantsDetails = message.details !== false;
          traffic.setRole(client.id, client.stateSubscriptions.size > 0 || client.wantsIndex, client.terminalSubscriptions.size > 0);

          for (const [tabId, stream] of client.terminalSubscriptions) {
            if (stream.mode !== "projection") continue;
            const subscription = projectionScheduler.subscribe(client.id, tabId, stream, {
              isOpen: () => client.socket.readyState === 1,
              bufferedAmount: () => Number(client.socket.bufferedAmount ?? 0),
              send: (payload) => {
                const result = socketSender.sendProjection(client.id, client.socket, payload);
                if (result === "sent") recordTraffic("out", "ws", "terminal.screen", Buffer.byteLength(payload, "utf8"));
                return result;
              },
              dropped: () => traffic.recordProjectionCandidateDropped(client.id, Number(client.socket.bufferedAmount ?? 0)),
            });
            stream.streamId = subscription.streamId;
            stream.viewportRows = subscription.viewportRows;
            stream.fps = subscription.fps;
            sendClient(client, {
              type: "terminal.subscription",
              tabId,
              mode: "projection",
              streamId: stream.streamId,
              viewportRows: stream.viewportRows,
              fps: stream.fps,
              writable: true,
            }, "state");
          }

          const affectedRawTabs = new Set(previousRawTabs);
          for (const [tabId, stream] of client.terminalSubscriptions) if (stream.mode === "raw") affectedRawTabs.add(tabId);
          for (const tabId of affectedRawTabs) refreshResponderLease(tabId);

          // Terminal snapshots are synchronous and go first. This establishes
          // the raw cursor before any awaited index/TabBundle read can let a
          // live PTY increment interleave ahead of the reset frame.
          for (const [tabId, stream] of client.terminalSubscriptions) {
            if (stream.mode !== "raw") continue;
            const terminal = pty.snapshot(tabId, stream.cursor);
            if (terminal) sendRawTerminal(client, tabId, { type: "terminal.output", ...terminal }, "terminal.snapshot");
          }

          // A reconnecting page missed every change made while it was away
          // (a phone that slept, a tunnel that dropped). Replay current
          // navigation on subscribe so it resyncs without a reload.
          if (client.wantsIndex) sendClient(client, { type: "index.changed", index: await storage.readIndex() }, "index");
          if (message.snapshots !== false) {
            for (const tabId of client.stateSubscriptions) {
              try {
                const data = await readClientTab(tabId);
                sendClient(client, { type: "snapshot", tabId, sequence: sequences.get(tabId) ?? 0, data }, "snapshot");
              } catch { /* tab may have been deleted */ }
            }
          }
        } else if (message.type === "terminal.sync" && message.tabId) {
          const tabId = String(message.tabId);
          const stream = client.terminalSubscriptions.get(tabId);
          if (!stream) {
            sendClient(client, wsError("TERMINAL_NOT_SUBSCRIBED", "Subscribe to the terminal before requesting a sync."), "error");
            return;
          }
          if (stream.mode === "projection") {
            projectionScheduler.requestFull(client.id, tabId);
            return;
          }
          rawBatcher.flush(tabId);
          const terminal = pty.snapshot(tabId, message.cursor ?? {});
          if (terminal) sendRawTerminal(client, tabId, { type: "terminal.output", ...terminal }, "terminal.snapshot");
        } else if (message.type === "terminal.screen.snapshot.request" && message.tabId) {
          const tabId = String(message.tabId);
          if (message.oneShot === true) {
            if (!client.stateSubscriptions.has(tabId)) {
              sendClient(client, wsError("TAB_NOT_SUBSCRIBED", "Subscribe to the tab before requesting a one-shot screen."), "error");
              return;
            }
            const snapshot = await pty.screenSnapshot(tabId, boundedInteger(message.viewportRows, 5, 60, 20));
            if (!snapshot) {
              sendClient(client, wsError("TERMINAL_SCREEN_UNAVAILABLE", "The current terminal screen is unavailable."), "error");
              return;
            }
            sendClient(client, fullTerminalScreenFrame(snapshot, { tabId, oneShot: true }), "terminal.snapshot");
            return;
          }
          const stream = client.terminalSubscriptions.get(tabId);
          if (!stream || stream.mode !== "projection" || !projectionScheduler.requestFull(client.id, tabId)) {
            sendClient(client, wsError("TERMINAL_PROJECTION_NOT_SUBSCRIBED", "Subscribe in projection mode before requesting a screen snapshot."), "error");
          }
        } else if (message.type === "snapshot.request" && message.tabId) {
          const tabId = String(message.tabId);
          if (!client.stateSubscriptions.has(tabId)) {
            sendClient(client, wsError("TAB_NOT_SUBSCRIBED", "Subscribe to the tab before requesting a snapshot."), "error");
            return;
          }
          const data = await readClientTab(tabId);
          sendClient(client, { type: "snapshot", tabId, sequence: sequences.get(tabId) ?? 0, data }, "snapshot");
        } else if (message.type === "terminal.input" && message.tabId) {
          const tabId = String(message.tabId);
          const stream = client.terminalSubscriptions.get(tabId);
          if (!stream) {
            sendClient(client, wsError("TERMINAL_NOT_SUBSCRIBED", "Subscribe to the terminal before sending input."), "error");
            return;
          }
          if (stream.mode === "raw" && rawResponderOwners.get(tabId) !== client.id) {
            sendClient(client, wsError("TERMINAL_READ_ONLY", "Another raw terminal client owns the input and responder lease."), "error");
            return;
          }
          const data = decodeTerminalInput(message.dataBase64, transportConfig.maxInputMessageBytes);
          if (data === null) {
            sendClient(client, wsError("TERMINAL_INPUT_INVALID", `Terminal input must be valid Base64 and no larger than ${transportConfig.maxInputMessageBytes} bytes.`), "error");
            return;
          }
          const tab = await storage.getTabMeta(tabId);
          if (tab.session.state !== "closed") {
            rawBatcher.markInteractive(tabId);
            projectionScheduler.markInteractive(tabId);
            pty.write(tabId, data);
            if (tab.session.provider === "claude") claude.existing(tabId)?.observeTerminalInput(data);
            if (tab.session.provider === "cursor") cursor.existing(tabId)?.observeTerminalInput(data);
            if (typeof message.inputId === "string" && message.inputId.length <= 128) {
              sendClient(client, { type: "terminal.input.ack", tabId, inputId: message.inputId }, "state");
            }
          }
        } else if (message.type === "terminal.resize" && message.tabId) {
          const tabId = String(message.tabId);
          const stream = client.terminalSubscriptions.get(tabId);
          if (!stream) {
            sendClient(client, wsError("TERMINAL_NOT_SUBSCRIBED", "Subscribe to the terminal before resizing it."), "error");
            return;
          }
          if (stream.mode !== "raw") {
            sendClient(client, wsError("TERMINAL_PROJECTION_RESIZE_FORBIDDEN", "Projection viewports do not resize the shared PTY."), "error");
            return;
          }
          if (rawResponderOwners.get(tabId) !== client.id) {
            sendClient(client, wsError("TERMINAL_READ_ONLY", "Another raw terminal client owns the resize lease."), "error");
            return;
          }
          if ((await storage.getTabMeta(tabId)).session.state !== "closed") {
            const cols = Number(message.cols);
            const rows = Number(message.rows);
            if (pty.resize(tabId, cols, rows)) await updateTerminalRuntime(storage, tabId, { cols, rows });
          }
        } else if (message.type === "approval.respond" && message.requestKey !== undefined) {
          const requestKey = String(message.requestKey);
          const pending = pendingApprovals.get(requestKey);
          if (pending) {
            pending.manager.rpc.respond(pending.requestId, message.response ?? {});
            pendingApprovals.delete(requestKey);
          }
        }
      } catch {
        sendClient(client, wsError("INVALID_WS_MESSAGE", "Invalid WebSocket message."), "error");
      }
    });
  });

  pty.on("event", async (event: any) => {
    if (event.type === "output") {
      rawBatcher.push({
        tabId: event.tabId,
        generation: event.generation,
        startOffset: event.startOffset,
        endOffset: event.endOffset,
        dataBase64: event.dataBase64,
      });
      projectionScheduler.markDirty(event.tabId, Math.max(0, Number(event.endOffset) - Number(event.startOffset)));
    }
    else {
      // Keep the final bytes (including an exit marker) ahead of terminal.state.
      rawBatcher.flush(event.tabId);
      refreshResponderLease(event.tabId);
      const state = event.state === "stopped" ? "stopped" : event.state === "running" ? "running" : event.state === "starting" ? "starting" : event.state === "error" ? "error" : "exited";
      try {
        const provider = (await storage.getTabMeta(event.tabId)).session.provider;
        const agentName = provider === "claude" ? "Claude Code" : provider === "cursor" ? "Cursor CLI" : "Codex";
        if (state === "error" || state === "exited") {
          const message = event.message ?? `${agentName} TUI exited.`;
          if (provider === "claude") claude.existing(event.tabId)?.observeTerminalExit(message);
          if (provider === "cursor") cursor.existing(event.tabId)?.observeTerminalExit(message);
        }
        await updateTerminalRuntime(storage, event.tabId, {
        state,
        lastExitCode: event.exitCode ?? null,
        // A terminal conversation *is* the shell, so typing `exit` ends it
        // normally. Reporting that as an agent TUI crashing would be wrong.
        lastError: state === "error" && provider !== "shell"
          ? {
            code: provider === "claude" ? "CLAUDE_TUI_EXITED" : provider === "cursor" ? "CURSOR_TUI_EXITED" : "CODEX_TUI_EXITED",
            message: event.message ?? `${agentName} TUI exited unexpectedly.`,
          }
          : null,
        });
      } catch { /* tab could be deleted */ }
      emit(event.tabId, { type: "terminal.state", state: event.state, exitCode: event.exitCode ?? null, message: event.message ?? null });
      projectionScheduler.forceFull(event.tabId);
    }
  });

  return app;
}

function stateTrafficKind(type: unknown): TerminalTrafficKind {
  if (type === "snapshot") return "snapshot";
  if (type === "error") return "error";
  return "state";
}

function wsError(code: string, message: string): { type: "error"; error: { code: string; message: string } } {
  return { type: "error", error: { code, message } };
}

function parseTabSubscriptions(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  const ids = value
    .slice(0, 1_000)
    .map(String)
    .filter((id) => id.length > 0 && id.length <= 256);
  return new Set(ids);
}

function parseTerminalSubscriptions(value: unknown): Map<string, TerminalStream> {
  const result = new Map<string, TerminalStream>();
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [tabId, rawConfig] of Object.entries(value).slice(0, 64)) {
    if (!tabId || tabId.length > 256 || !rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) continue;
    const config = rawConfig as Record<string, unknown>;
    if (config.mode === "projection") {
      result.set(tabId, {
        mode: "projection",
        viewportRows: boundedInteger(config.viewportRows, 5, 60, 20),
        fps: boundedInteger(config.fps, 1, 5, 2),
        streamId: "",
      });
      continue;
    }
    if (config.mode !== undefined && config.mode !== "raw") throw new Error("Unsupported terminal transport mode");
    const nextOffset = Number(config.nextOffset);
    const maxCatchUpBytes = Number(config.maxCatchUpBytes);
    result.set(tabId, {
      mode: "raw",
      cursor: {
        generation: typeof config.generation === "string" ? config.generation : null,
        nextOffset: Number.isSafeInteger(nextOffset) && nextOffset >= 0 ? nextOffset : null,
        ...(Number.isSafeInteger(maxCatchUpBytes) && maxCatchUpBytes >= 0
          ? { maxCatchUpBytes: Math.min(64 * 1024, maxCatchUpBytes) }
          : {}),
      },
      streamId: randomUUID(),
      sequence: 0,
    });
  }
  return result;
}

/**
 * Serve a read through the browser's cache instead of the wire.
 *
 * The body is stored by the browser and revalidated on the next request; an
 * unchanged conversation then costs a 304 rather than its answer text again.
 * The tag has to be computed here, before @fastify/compress rewrites the
 * payload, so it identifies the content and not one particular encoding.
 */
function sendRevalidatable(request: FastifyRequest, reply: FastifyReply, data: unknown): FastifyReply {
  const body = JSON.stringify({ data });
  const etag = entityTag(body);
  reply.header("cache-control", REVALIDATE_CACHE_CONTROL);
  reply.header("vary", REVALIDATE_VARY);
  reply.header("etag", etag);
  if (ifNoneMatchSatisfied(request.headers["if-none-match"], etag)) return reply.code(304).send();
  return reply.type("application/json; charset=utf-8").send(body);
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

async function validWorkingDirectory(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !value.trim()) return null;
  const candidate = path.resolve(value.trim());
  try { const stat = await fs.stat(candidate); return stat.isDirectory() ? candidate : null; } catch { return null; }
}

async function rememberAppServer(storage: StorageService, tabId: string, manager: AppServerManager): Promise<void> {
  const ownership = manager.ownership;
  if (!ownership) throw new Error("APP_SERVER_OWNERSHIP_MISSING");
  await updateTerminalRuntime(storage, tabId, { appServer: ownership });
}

async function stopAppServer(storage: StorageService, codex: AppServerPool, tabId: string): Promise<void> {
  const ownership = (await storage.readTab(tabId).catch(() => null))?.runtime.terminal.appServer ?? null;
  let stopError: unknown = null;
  try { await codex.stop(tabId); }
  catch (error) { stopError = error; }
  let fallbackTerminated = false;
  if (ownership) fallbackTerminated = await terminateStaleAppServer(ownership);
  if (stopError && !fallbackTerminated) throw stopError;
  await updateTerminalRuntime(storage, tabId, { appServer: null });
}

async function updateTerminalRuntime(storage: StorageService, tabId: string, patch: Partial<RuntimeFile["terminal"]>): Promise<void> {
  await storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    const runtime = RuntimeFileSchema.parse({ ...bundle.runtime, terminal: { ...bundle.runtime.terminal, ...patch }, revision: bundle.runtime.revision + 1 });
    await storage.writeRuntime(tabId, runtime);
  });
}

async function restoreTerminalSize(storage: StorageService, pty: PtyManager, tabId: string): Promise<void> {
  const { cols, rows } = (await storage.readTab(tabId)).runtime.terminal;
  if (cols !== null && rows !== null) pty.resize(tabId, cols, rows);
}

async function clearSessionNotReadyError(storage: StorageService, tabId: string): Promise<void> {
  await storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    if (bundle.runtime.runner.lastError?.code !== "SESSION_NOT_READY") return;
    const runtime = RuntimeFileSchema.parse({
      ...bundle.runtime,
      revision: bundle.runtime.revision + 1,
      runner: {
        ...bundle.runtime.runner,
        // Clearing the error is the job here; the queue's intent is not the
        // error's to reset, and an armed conversation stays armed.
        desiredState: settledDesiredState(bundle.runtime.runner.desiredState),
        state: "paused",
        activePromptId: null,
        activeTurnId: null,
        lastError: null,
        lastTransitionAt: isoNow(),
      },
    });
    await storage.writeRuntime(tabId, runtime);
  });
}

export function tabsToRestore(tabs: TabMeta[]): string[] {
  return tabs
    .filter((tab) => Boolean(
      // A terminal has no thread; its working directory is what makes it
      // restorable, so requiring a threadId here would silently drop it.
      (tab.session.threadId || tab.session.provider === "shell")
      && tab.session.workingDirectory
      && (tab.session.reopenOnLaunch || tab.session.state === "ready"),
    ))
    .map((tab) => tab.id);
}

export async function recordOpenSessionsForNextLaunch(storage: StorageService): Promise<string[]> {
  const tabs = await storage.listTabMeta();
  const openIds = tabs
    .filter((tab) => tab.session.state === "ready" && tab.session.threadId && tab.session.workingDirectory)
    .map((tab) => tab.id);
  const open = new Set(openIds);
  for (const tab of tabs) {
    const reopenOnLaunch = open.has(tab.id);
    if (tab.session.reopenOnLaunch === reopenOnLaunch) continue;
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, reopenOnLaunch },
      updatedAt: isoNow(),
    }));
  }
  return openIds;
}

export async function recoverTerminalRuntime(storage: StorageService): Promise<number> {
  let recovered = 0;
  for (const tab of await storage.listTabMeta()) {
    await storage.withTabLock(tab.id, async () => {
      const bundle = await storage.readTab(tab.id);
      const staleAppServer = bundle.runtime.terminal.appServer;
      let appServerCleanupError: { code: string; message: string } | null = null;
      if (staleAppServer) {
        try { await terminateStaleAppServer(staleAppServer); }
        catch (error) { appServerCleanupError = { code: "STALE_APP_SERVER_CLEANUP_FAILED", message: error instanceof Error ? error.message : String(error) }; }
      }
      const terminalStale = bundle.runtime.terminal.state === "starting" || bundle.runtime.terminal.state === "running";
      const sessionStale = bundle.tab.session.state === "ready" || bundle.tab.session.state === "connecting";
      // An idle intent -- stopped or armed -- is not stale. It is a choice the
      // user made, there is nothing in flight behind it, and it belongs to the
      // conversation rather than to the process that happened to be running.
      const runnerStale = bundle.runtime.runner.desiredState === "running"
        || bundle.runtime.runner.state !== "paused"
        || bundle.runtime.runner.activePromptId !== null
        || bundle.runtime.runner.activeTurnId !== null;
      const promptStale = bundle.prompts.prompts.some((prompt) => prompt.status === "dispatching" || prompt.status === "running");
      if (!terminalStale && !sessionStale && !runnerStale && !promptStale && !staleAppServer) return;
      const recoveredAt = isoNow();
      if (terminalStale || sessionStale || runnerStale || staleAppServer) {
        const runtime = RuntimeFileSchema.parse({
          ...bundle.runtime,
          revision: bundle.runtime.revision + 1,
          runner: { ...bundle.runtime.runner, desiredState: settledDesiredState(bundle.runtime.runner.desiredState), state: "paused", activePromptId: null, activeTurnId: null, lastTransitionAt: recoveredAt },
          terminal: {
            ...bundle.runtime.terminal,
            state: appServerCleanupError ? "error" : "stopped",
            lastExitCode: null,
            lastError: appServerCleanupError,
            appServer: appServerCleanupError ? staleAppServer : null,
          },
        });
        await storage.writeRuntime(tab.id, runtime);
      }
      if (promptStale) {
        const error = { code: "SERVICE_RESTARTED", message: "Codex Promptor restarted before this queued turn was finalized." };
        const staleTurnPrompts = bundle.prompts.prompts.filter((prompt) => (prompt.status === "dispatching" || prompt.status === "running")
          && prompt.threadId
          && prompt.codexTurnId);
        const prompts = PromptFileSchema.parse({
          ...bundle.prompts,
          revision: bundle.prompts.revision + 1,
          updatedAt: recoveredAt,
          prompts: bundle.prompts.prompts.map((prompt) => {
            if (prompt.status !== "dispatching" && prompt.status !== "running") return prompt;
            return {
              ...prompt,
              status: "interrupted",
              completedAt: recoveredAt,
              updatedAt: recoveredAt,
              error,
              attempts: prompt.attempts.map((attempt) => attempt.status === "dispatching" || attempt.status === "running"
                ? { ...attempt, status: "interrupted", completedAt: recoveredAt, error }
                : attempt),
            };
          }),
        });
        await storage.writePrompts(tab.id, prompts);
        const recoveredTurns = new Set<string>();
        let answersChanged = false;
        for (const stalePrompt of staleTurnPrompts) {
          const threadId = stalePrompt.threadId!;
          const turnId = stalePrompt.codexTurnId!;
          const turnKey = `${threadId}:${turnId}`;
          if (recoveredTurns.has(turnKey)) continue;
          recoveredTurns.add(turnKey);
          const linked = prompts.prompts.filter((prompt) => prompt.threadId === threadId && prompt.codexTurnId === turnId);
          const primary = linked.find((prompt) => prompt.attempts.some((attempt) => attempt.codexTurnId === turnId && attempt.delivery === "turn"))
            ?? linked[0]
            ?? stalePrompt;
          const promptText = linked.map((prompt) => prompt.text.trim()).filter(Boolean).join("\n\n--- 追加输入 ---\n\n") || primary.text;
          const metadata = {
            promptIds: linked.map((prompt) => prompt.id),
            steeredPromptIds: linked.filter((prompt) => prompt.attempts.some((attempt) => attempt.codexTurnId === turnId && attempt.delivery === "steer")).map((prompt) => prompt.id),
          };
          const answer = bundle.answers.answers.find((item) => item.threadId === threadId && item.codexTurnId === turnId);
          if (answer) {
            answer.promptId = primary.id;
            answer.origin = primary.origin;
            answer.prompt = promptText;
            answer.status = "interrupted";
            answer.finalAnswer = "";
            answer.captureMode = null;
            answer.startedAt = answer.startedAt ?? primary.startedAt;
            answer.completedAt = recoveredAt;
            answer.clientUserMessageId = answer.clientUserMessageId ?? primary.clientUserMessageId;
            answer.error = error;
            answer.metadata = metadata;
          } else {
            const interruptedAnswer: AnswerRecord = {
              id: randomUUID(),
              promptId: primary.id,
              threadId,
              codexTurnId: turnId,
              origin: primary.origin,
              prompt: promptText,
              status: "interrupted",
              finalAnswer: "",
              captureMode: null,
              startedAt: primary.startedAt,
              completedAt: recoveredAt,
              recordedAt: recoveredAt,
              clientUserMessageId: primary.clientUserMessageId,
              error,
              metadata,
            };
            bundle.answers.answers.push(interruptedAnswer);
          }
          answersChanged = true;
        }
        if (answersChanged) {
          bundle.answers.revision += 1;
          bundle.answers.updatedAt = recoveredAt;
          await storage.writeAnswers(tab.id, bundle.answers);
        }
      }
      if (sessionStale) {
        const recoveredTab = { ...bundle.tab, session: { ...bundle.tab.session, state: "closed" as const, lastError: null }, updatedAt: recoveredAt };
        await storage.writeTab(recoveredTab);
        await storage.updateIndex((index) => ({ ...index, tabs: index.tabs.map((item) => item.id === tab.id ? recoveredTab : item) }));
      }
      recovered += 1;
    });
  }
  return recovered;
}

function apiError(reply: FastifyReply, statusCode: number, code: string, message: string, retryable = false) {
  return reply.code(statusCode).send({ error: { code, message, details: {}, retryable } });
}

function sendDocumentError(reply: FastifyReply, error: unknown) {
  reply.header("Cache-Control", "no-store");
  if (error instanceof DocumentError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, details: error.details, retryable: false } });
  }
  return reply.code(500).send({ error: { code: "DOCUMENT_CHUNK_FAILED", message: "The document request failed.", details: {}, retryable: false } });
}

/** Carries its own status and code so routes never have to match on message text. */
class QueueUnavailableError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "QueueUnavailableError";
  }
}

/**
 * Guards every queue and runner route. Besides the closed check, this is what
 * keeps a terminal conversation out of the queue machinery: the RunnerManager
 * binder falls back to `codex.get(tabId)`, which would *create* an App Server
 * manager for a tab that has no agent at all, so the refusal has to happen
 * before the route touches a runner -- disabling the buttons is not enough.
 */
function assertQueueUsable(bundle: TabBundle): void {
  if (bundle.tab.session.state === "closed") {
    throw new QueueUnavailableError(423, "CONVERSATION_CLOSED", "对话已关闭，请先重新打开终端。");
  }
  if (bundle.tab.session.provider === "shell") {
    throw new QueueUnavailableError(400, "SHELL_QUEUE_UNSUPPORTED", "终端对话不执行队列，请直接在终端里输入命令。");
  }
}

function isActiveWriterError(message: string): boolean {
  return /active writer|already has an active writer|thread\/resume failed.*writer/i.test(message);
}

export function isLocalHost(host: string | undefined): boolean {
  return Boolean(host) && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host!);
}

export function isTrustedBrowserOrigin(origin: string | undefined, host: string | undefined, trustedHosts: readonly string[] = []): boolean {
  if (!origin || !host) return false;
  const normalizedHost = host.toLowerCase();
  if (!isLocalHost(normalizedHost) && !trustedHosts.includes(normalizedHost)) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host.toLowerCase() === normalizedHost;
  } catch {
    return false;
  }
}

export function isTrustedBrowserRequest(headers: { origin?: string; referer?: string; host?: string }, trustedHosts: readonly string[] = []): boolean {
  return isTrustedBrowserOrigin(headers.origin, headers.host, trustedHosts) || isTrustedBrowserOrigin(headers.referer, headers.host, trustedHosts);
}
