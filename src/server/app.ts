import { resolveTerminalInputHandle, TERMINAL_INPUT_COMPACT_TYPE } from "../shared/terminal-input.js";
import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCompress from "@fastify/compress";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { AgentProviderSchema, type AgentProvider, type AnswerRecord, CommonPromptFileSchema, type Group, type IndexFile, IndexFileSchema, isoNow, MAX_AUXILIARY_FILE_BYTES, MAX_COMMON_PROMPTS, MAX_TIMER_REQUEST_BYTES, newPrompt, PromptFileSchema, RuntimeFileSchema, type RuntimeFile, type TabBundle, type TabMeta } from "../shared/schemas.js";
import { runnerIsWorking, settledDesiredState, type TabActivitySummary } from "../shared/tab-activity.js";
import type { PromptDelta } from "../shared/tab-delta.js";
import { reorderPromptIds } from "../shared/prompt-order.js";
import {
  EARLIER_ANSWER_PAGE,
  EARLIER_PROMPT_PAGE,
  INITIAL_ANSWER_WINDOW,
  INITIAL_PROMPT_WINDOW,
  MAX_WINDOW_RECORDS,
} from "../shared/tab-window.js";
import { AppServerPool, type AppServerManager, type CodexRpcClient, terminateStaleAppServer, waitForThreadLoaded } from "./codex.js";
import { CodexTuiPool, codexHookFailureText, codexHookStartupError, codexStartupQuestion, codexStartupQuestionFrom, codexTuiReady, resolveCodexTuiLaunch, type CodexTuiManager } from "./codex-tui.js";
import { ClaudeCodePool, type ClaudeCodeManager, probeClaudeVersion } from "./claude.js";
import { syncClaudeHistory } from "./claude-history.js";
import { buildCursorCommand, CursorCliPool, type CursorCliManager, ensureCursorHookBridge, probeCursorVersion } from "./cursor.js";
import { syncCursorHistory } from "./cursor-history.js";
import { DirectoryPickerBusyError, DirectoryPickerService } from "./directory-picker.js";
import { buildConversationMarkdown, conversationExportFilename } from "./conversation-export.js";
import { DocumentError, DocumentService, isLocalBrowserRequest } from "./documents.js";
import { continuesThread, locateCodexRollout, readCodexRolloutThread, readCodexThreadForHistory, readRolloutHistoryBase, repointThread } from "./codex-history.js";
import { decideStall, noteRolloutSize, TURN_STALL_POLL_MS, type RolloutProgress } from "./turn-stall.js";
import { appendBoundedLines } from "./log-file.js";
import { readCodexRolloutCached } from "./codex-rollout-cache.js";
import { RESTORE_STAGGER_MS, restoreOrder, runRestoreQueue, type RestoreQueue } from "./restore-plan.js";
import { appendRestoreTimings, createPhaseRecorder, formatDuration, formatRestoreTimings, type PhaseRecorder, type RestoreTrace } from "./restore-timing.js";
import { historyThreadFromResponse, recordTurn, syncHistory } from "./history.js";
import { applyNavigationOrder, deleteGroupAndUngroupTabs } from "./navigation.js";
import { entityTag, ifMatchSatisfied, ifNoneMatchSatisfied, REVALIDATE_CACHE_CONTROL, REVALIDATE_VARY } from "./http-cache.js";
import { CLAUDE_EXIT_MARKER, CODEX_EXIT_MARKER, CURSOR_EXIT_MARKER, PtyManager, sessionExitMarker, type TerminalCursor } from "./pty.js";
import { isSlashCommandPrompt } from "./prompt-submit.js";
import { RunnerManager } from "./queue.js";
import { recordsForCurrentThread, StorageService } from "./storage.js";
import { TimerService, TimerServiceError } from "./timer-service.js";
import {
  BoundedWebSocketSender,
  decodeTerminalInput,
  plainTerminalInput,
  RawTerminalBatcher,
  TERMINAL_PROTOCOL_VERSION,
  TerminalTrafficMeter,
  terminalTransportConfigFromEnv,
  type TerminalTrafficKind,
} from "./terminal-transport.js";
import { defaultProjectionSchedulerConfig, fullTerminalScreenFrame, TerminalProjectionScheduler } from "./terminal-projection.js";
import { createTrafficLedger, rollupBuckets, type TrafficLedger } from "./traffic-ledger.js";
import { newKeyMaterial } from "./e2ee-key-material.js";
import { handshakeAnswered, masterKeyFor, startHandshake, type PendingHandshake } from "./e2ee-session.js";
import { HANDSHAKE_PROOF, HANDSHAKE_READY, allowedBeforeHandshake } from "../shared/e2ee-handshake.js";
import { redactForScope } from "./e2ee-redaction.js";
import { normalizePassphrase } from "../shared/e2ee-keys.js";
import { classifyNetworkScope, type NetworkScope } from "./traffic-scope.js";
import { buildIndexDelta, indexDeltaIsEmpty } from "../shared/index-delta.js";
import { createTrafficLog } from "./traffic-log.js";
import { chooseResumeThread } from "./codex-thread-fallback.js";
import { syncTerminalThreadSelection } from "./terminal-thread-sync.js";
import { InitialTuiThreadGate, type TuiThreadSelection, type TuiThreadSelectionHandler } from "./tui-protocol.js";
import { TuiProxyPool } from "./tui-proxy.js";
import { DEFAULT_UI_GRACE_MS, UiLifecycle } from "./ui-lifecycle.js";
import { loadTrustedBrowserHosts } from "./trusted-hosts.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CodexConnectionMode = "app-server" | "pty-hooks";

/**
 * Codex runs over the native TUI with hooks by default. The App Server remains
 * reachable with `CODEX_PROMPTOR_CODEX_CONNECTION_MODE=app-server` as a way
 * back, because the two transports differ in how a conversation is created:
 * hooks bind a tab when SessionStart fires, which is after the first prompt,
 * so a thread only becomes a tab's own once Codex has written it to disk.
 */
export function codexConnectionModeFromEnv(value: unknown): CodexConnectionMode {
  return String(value ?? "").trim().toLowerCase() === "app-server" ? "app-server" : "pty-hooks";
}

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
  /** Which link this connection is on, decided once from the socket and the Host it arrived under. */
  scope: NetworkScope;
  /** The socket underneath the WebSocket, where the only real byte counters live. */
  netSocket: { bytesWritten?: number; bytesRead?: number } | null;
  /** Counter values at the last sample, so each interval is attributed to its own bucket. */
  wireOutAt: number;
  wireInAt: number;
  /** Serialized payload sent since the last sample, which is the numerator of the compression ratio. */
  payloadOut: number;
  payloadIn: number;
  /** The index revision this client was last sent, so the next one can be a delta. */
  indexRevision: number | null;
};

export type RestoreOpenSessionsSummary = {
  restored: string[];
  failed: Array<{ tabId: string; code: string; message: string }>;
  /** Ready-to-print lines saying where the startup time went. */
  timings: string[];
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
    codexTui: CodexTuiPool;
    codexConnectionMode: CodexConnectionMode;
    claude: ClaudeCodePool;
    cursor: CursorCliPool;
    pty: PtyManager;
    runners: RunnerManager;
    timers: TimerService;
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
  const codexTui = new CodexTuiPool(pty);
  const claude = new ClaudeCodePool(pty);
  const cursor = new CursorCliPool(pty);
  const tuiProxy = new TuiProxyPool();
  const directoryPicker = new DirectoryPickerService();
  const ui = new UiLifecycle(Number(process.env.CODEX_PROMPTOR_UI_GRACE_MS ?? DEFAULT_UI_GRACE_MS));
  const token = process.env.CODEX_PROMPTOR_TOKEN ?? randomBytes(32).toString("hex");
  const codexConnectionMode = codexConnectionModeFromEnv(process.env.CODEX_PROMPTOR_CODEX_CONNECTION_MODE);
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
    channel: "ws" | "http" | "wire",
    type: string,
    bytes: number,
    options: { rawBytes?: number; scope?: NetworkScope } = {},
  ): void => {
    if (trafficLoggingEnabled) ledger.record(direction, channel, type, bytes, options);
  };
  const terminalResyncTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const rawResponderOwners = new Map<string, string>();
  const responderLeaseEpochs = new Map<string, number>();
  const pendingApprovals = new Map<string, { tabId: string; manager: AppServerManager; requestId: number | string }>();
  const hookLeases = new Map<string, { nonce: string; secret: string }>();
  const threadSwitches = new Map<string, Promise<void>>();
  const noAuth = process.env.CODEX_PROMPTOR_NO_AUTH === "1";
  // Hosts beyond 127.0.0.1/localhost that a reverse proxy (e.g. a Cloudflare
  // Tunnel hostname already gated by Cloudflare Access) forwards requests for.
  // The browser's Origin/Referer still has to match exactly, so this only
  // widens *which* host is eligible for the same-origin check below — it
  // does not skip the check itself.
  const claudeVersion = probeClaudeVersion();
  const cursorVersion = probeCursorVersion();

  await storage.ensure();
  const trustedHosts = await loadTrustedBrowserHosts(rootDir, process.env.CODEX_PROMPTOR_TRUSTED_HOSTS);
  const documents = await DocumentService.create(rootDir, storage);
  const readClientTab = (tabId: string): Promise<TabBundle> => storage.readTabWindow(tabId, INITIAL_PROMPT_WINDOW, INITIAL_ANSWER_WINDOW);

  /**
   * The key this machine is currently using, or null when encryption is off.
   *
   * Derived lazily and cached by fingerprint: PBKDF2 is a few hundred
   * milliseconds and a connection should not pay for it, but the fingerprint
   * moves whenever the passphrase or its salt does, so a stale cache cannot
   * outlive the key it was derived from.
   */
  let cachedKey: { fingerprint: string; master: Buffer; salt: string; iterations: number } | null = null;
  const encryptionState = async (): Promise<{ master: Buffer; fingerprint: string; salt: string; iterations: number } | null> => {
    const tabs = await storage.listTabMeta().catch(() => []);
    const switchTab = tabs.find((tab) => tab.session.provider === "p2p" && tab.session.e2ee);
    if (!switchTab) { cachedKey = null; return null; }
    const declared = switchTab.session.e2ee!.fingerprint;
    if (cachedKey?.fingerprint === declared) return cachedKey;
    const derived = await masterKeyFor(switchTab.session).catch(() => null);
    if (!derived) { cachedKey = null; return null; }
    cachedKey = { ...derived, salt: switchTab.session.e2ee!.salt, iterations: switchTab.session.e2ee!.iterations };
    return cachedKey;
  };
  const startupOpenTabIds = tabsToRestore(await storage.listTabMeta());
  /**
   * Reads this tab's rollout incrementally. The five conversations open on the
   * machine this was measured on come to roughly half a gigabyte of rollout,
   * and every launch used to parse all of it from the first byte.
   */
  const cachedRollout = (tabId: string) => (file: string, threadId: string) =>
    readCodexRolloutCached(file, threadId, storage.historyCachePath(tabId));
  /**
   * The tab a page last had open, remembered so the next launch restores it
   * first. Only the selected TabView opens a terminal socket, so a terminal
   * subscription is the selection.
   */
  let lastSelectedTabId: string | null = (await storage.readIndex()).ui.lastSelectedTabId;
  let restoreQueue: RestoreQueue | null = null;
  await recoverTerminalRuntime(storage);

  /**
   * The ledger key for one outbound message.
   *
   * `terminal.output` used to cover both live PTY bytes and a full buffer
   * replay, which put 97% of a day's bytes behind one name that answered
   * nothing. The sender already knows which it is -- it passes the kind -- so
   * the two now separate, and a projection frame says whether it is a full
   * repaint or a delta.
   */
  const trafficTypeOf = (message: Record<string, unknown>, kind: TerminalTrafficKind): string => {
    const type = String(message.type ?? kind);
    if (type === "terminal.output") return kind === "terminal.snapshot" ? "terminal.output.snapshot" : "terminal.output.live";
    if (type === "terminal.screen") return message.full === true ? "terminal.screen.full" : "terminal.screen.delta";
    return type;
  };

  const sendClient = (client: Client, message: Record<string, unknown>, kind: TerminalTrafficKind): boolean => {
    // Every WebSocket message is serialized here and nowhere else, and the
    // scope is already known, so this is the one place the passphrase has to
    // be taken back out (see e2ee-redaction.ts).
    const payload = JSON.stringify(redactForScope(message, client.scope));
    const sent = socketSender.send(client.id, client.socket, payload, kind);
    // Counted only when it actually left: a frame dropped for backpressure
    // costs no bandwidth, and counting it would hide the drop.
    if (sent) {
      const bytes = Buffer.byteLength(payload, "utf8");
      client.payloadOut += bytes;
      recordTraffic("out", "ws", trafficTypeOf(message, kind), bytes, { scope: client.scope });
    }
    return sent;
  };

  /**
   * What a connection actually put on the wire since the last sample.
   *
   * Per-message wire attribution is not possible: several messages share a TLS
   * record, and with context takeover a frame's compressed size depends on the
   * frames before it. The connection boundary is where the question can be
   * answered honestly, so `bytes` here is the socket delta and `rawBytes` is
   * the payload that produced it -- their ratio is the only real compression
   * ratio this service records.
   */
  const sampleConnectionWire = (client: Client): void => {
    if (!trafficLoggingEnabled) return;
    const written = Number(client.netSocket?.bytesWritten ?? Number.NaN);
    const read = Number(client.netSocket?.bytesRead ?? Number.NaN);
    if (Number.isFinite(written) && written > client.wireOutAt) {
      recordTraffic("out", "wire", "socket", written - client.wireOutAt, { rawBytes: client.payloadOut, scope: client.scope });
      client.wireOutAt = written;
      client.payloadOut = 0;
    }
    if (Number.isFinite(read) && read > client.wireInAt) {
      recordTraffic("in", "wire", "socket", read - client.wireInAt, { rawBytes: client.payloadIn, scope: client.scope });
      client.wireInAt = read;
      client.payloadIn = 0;
    }
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
  // The index carries every tab's metadata, so one tab's timestamp moving used
  // to resend all of them -- 13.5KB a time, 88 times in a measured hour, 10% of
  // everything crossing the tunnel. A client that is holding the previous
  // revision gets only what changed; anyone else still gets the whole thing.
  let previousIndex: IndexFile | null = null;
  const sendIndex = (client: Client, index: IndexFile): void => {
    const base = previousIndex;
    if (base && base.revision === client.indexRevision && index.revision !== base.revision) {
      const delta = buildIndexDelta(base, index);
      // A write that changed nothing viewers can see is not worth a frame,
      // but the client's revision still has to move or it falls back to full.
      if (indexDeltaIsEmpty(delta)) { client.indexRevision = index.revision; return; }
      // A delta is not smaller by definition: on a two-tab index its
      // bookkeeping costs more than the tabs it avoids repeating. Send
      // whichever encoding actually is, so this can never make things worse.
      const asDelta = { type: "index.changed", delta };
      const smaller = JSON.stringify(asDelta).length < JSON.stringify({ type: "index.changed", index }).length
        ? asDelta
        : { type: "index.changed", index };
      if (sendClient(client, smaller, "index")) client.indexRevision = index.revision;
      return;
    }
    if (sendClient(client, { type: "index.changed", index }, "index")) client.indexRevision = index.revision;
  };
  const broadcastIndex = (index: IndexFile) => {
    for (const client of clients) {
      if (client.wantsIndex) sendIndex(client, index);
    }
    previousIndex = index;
  };
  storage.onIndexChanged(broadcastIndex);
  storage.onTabChanged((tabId, tab) => emit(tabId, { type: "tab.changed", tab }, true));
  storage.onPromptsChanged((tabId, delta) => emit(tabId, { type: "prompts.changed", delta }, true));
  storage.onAnswersChanged((tabId, delta) => {
    emit(tabId, { type: "answers.changed", delta }, true);
  });
  // The delta when there is one to send, the whole runtime only for a tab that
  // had none to compare against. A receiver that cannot apply the delta asks
  // for a snapshot, which is the same path a missed revision already takes.
  storage.onRuntimeChanged((tabId, runtime, delta) => emit(tabId, delta
    ? { type: "runner.changed", delta }
    : { type: "runner.changed", runner: runtime }));

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

  const runners = new RunnerManager(storage, (tabId) => cursor.existing(tabId)
    ?? claude.existing(tabId)
    ?? (codexConnectionMode === "pty-hooks" ? codexTui.get(tabId) : codex.get(tabId)), (event) => {
    if (event.type === "error") emit(event.tabId, { type: "error", error: event.data });
    if (event.type === "answer") {
      const answer = event.data as AnswerRecord | undefined;
      if ((answer?.origin === "queue" || answer?.origin === "timer") && answer.status === "completed") {
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
  const timers = new TimerService(storage, (tabId) => runners.get(tabId), (key, active) => ui.setBackgroundHold(key, active));

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
        isDurableThread: async (threadId) => Boolean(await rolloutFile(threadId)),
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
        // A manual turn that finished is proof the agent is working.
        if (String(event.turn?.status ?? "") === "completed") {
          await clearRunnerFailure(storage, tabId);
          await emitSnapshot(tabId);
        }
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
    provider: "codex" | "claude" | "cursor",
    tabId: string,
    manager: CodexTuiManager | ClaudeCodeManager | CursorCliManager,
    session: { sessionId: string; cwd: string; transcriptPath: string | null },
  ): Promise<void> => {
    const previousTask = threadSwitches.get(tabId) ?? Promise.resolve();
    const task = previousTask.catch(() => undefined).then(async () => {
      const currentManager = provider === "codex"
        ? codexTui.existing(tabId)
        : provider === "claude" ? claude.existing(tabId) : cursor.existing(tabId);
      if (currentManager !== manager) return;
      const tab = await storage.getTabMeta(tabId);
      const fromThreadId = tab.session.threadId;
      if (tab.session.provider !== provider || tab.session.state !== "ready" || fromThreadId === session.sessionId) return;
      // Nothing to switch away from: a new Codex conversation is bound here,
      // when the first submitted prompt finally makes Codex create the thread.
      const adopting = !fromThreadId;

      // SessionStart has already moved the native TUI. Stop any old queue turn
      // before rebinding persistence, then keep pending prompts for the newly
      // selected conversation through the common history reconciliation.
      if (!adopting) await runners.get(tabId).freeze().catch(() => undefined);
      const switchedAt = isoNow();
      // Codex rolls a long conversation into a fresh thread by itself, keeping
      // the old rollout as the new one's history base. Following that is right;
      // calling it a conversation switch is not, because nobody switched.
      const rolloutPath = provider === "codex"
        ? session.transcriptPath ?? await rolloutFile(session.sessionId)
        : null;
      const historyBase = rolloutPath ? await readRolloutHistoryBase(rolloutPath).catch(() => null) : null;
      const method = continuesThread(historyBase, fromThreadId) ? "thread/fork" as const : "session/start" as const;
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
          lastThreadSwitch: adopting
            ? current.session.lastThreadSwitch
            : { fromThreadId: fromThreadId!, toThreadId: session.sessionId, method, switchedAt },
        },
        updatedAt: switchedAt,
      }));
      // A roll-over is the same conversation continuing, so what was already
      // said follows it onto the new thread. Done before the sync below, so a
      // turn the fork's own rollout repeats is recognised as one of these
      // rather than stored a second time.
      if (method === "thread/fork" && fromThreadId) {
        const bundle = await storage.readTab(tabId);
        const prompts = repointThread(bundle.prompts.prompts, fromThreadId, session.sessionId);
        if (prompts.moved) await storage.writePrompts(tabId, { ...bundle.prompts, prompts: prompts.records });
        const answers = repointThread(bundle.answers.answers, fromThreadId, session.sessionId);
        if (answers.moved) await storage.writeAnswers(tabId, { ...bundle.answers, answers: answers.records });
      }
      if (provider === "codex") {
        const thread = await readCodexRolloutThread(session.sessionId, session.transcriptPath);
        if (thread) await syncHistory(storage, tabId, thread, { mode: "merge" });
      } else if (provider === "claude") await syncClaudeHistory(storage, tabId, session.sessionId, session.transcriptPath);
      else await syncCursorHistoryIfAvailable(tabId, session.sessionId, session.transcriptPath);
      await clearSessionNotReadyError(storage, tabId);
      if (!adopting) emit(tabId, { type: "thread.switched", switch: { fromThreadId: fromThreadId!, toThreadId: session.sessionId, method, switchedAt } });
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

  const markSubmissionUnconfirmed = (tabId: string): void => {
    void (async () => {
      let changed = false;
      await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        if (!bundle.runtime.runner.activePromptId || bundle.runtime.runner.activeTurnId || bundle.runtime.runner.state !== "dispatching") return;
        await storage.writeRuntime(tabId, RuntimeFileSchema.parse({
          ...bundle.runtime,
          revision: bundle.runtime.revision + 1,
          runner: {
            ...bundle.runtime.runner,
            state: "reconciling",
            // A prompt that may have run must stay pending, but it is not yet a
            // known provider turn. `stalledSince` is reserved for known turns
            // whose provider record actually stopped growing; reusing it here
            // produced a no-progress label that no turn-progress sweep could
            // clear because there was deliberately no activeTurnId yet.
            stalledSince: null,
            lastTransitionAt: isoNow(),
          },
        }));
        changed = true;
      });
      if (changed) emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true);
    })().catch(() => undefined);
  };

  codexTui.on("created", ({ tabId, manager }: { tabId: string; manager: CodexTuiManager }) => {
    manager.on("submissionUnconfirmed", () => markSubmissionUnconfirmed(tabId));
    manager.on("session", (session) => void scheduleNativeSessionSwitch("codex", tabId, manager, session));
    manager.on("compacted", () => scheduleCompactionTerminalResync(tabId));
    manager.on("turnCompleted", async (event: any) => {
      try {
        if (event.origin === "queue") return;
        const tab = await storage.getTabMeta(tabId);
        if (tab.session.provider !== "codex" || tab.session.threadId !== event.threadId) return;
        const bundle = await storage.readTab(tabId);
        if (bundle.runtime.runner.activeTurnId === event.turnId) return;
        await recordTurn(storage, tabId, { threadId: event.threadId, turn: event.turn, items: event.items, origin: "manual" });
        // A manual turn that finished is proof the agent is working.
        if (String(event.turn?.status ?? "") === "completed") {
          await clearRunnerFailure(storage, tabId);
          await emitSnapshot(tabId);
        }
      } catch { /* explicit history sync reconstructs a missed manual turn */ }
    });
  });

  claude.on("created", ({ tabId, manager }: { tabId: string; manager: ClaudeCodeManager }) => {
    manager.on("submissionUnconfirmed", () => markSubmissionUnconfirmed(tabId));
    manager.on("session", (session) => void scheduleNativeSessionSwitch("claude", tabId, manager, session));
    manager.on("turnCompleted", async (event: any) => {
      try {
        if (event.origin === "queue") return;
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
        // A manual turn that finished is proof the agent is working.
        if (String(event.turn?.status ?? "") === "completed") {
          await clearRunnerFailure(storage, tabId);
          await emitSnapshot(tabId);
        }
      } catch { /* explicit history sync can reconstruct the transcript later */ }
    });
  });

  cursor.on("created", ({ tabId, manager }: { tabId: string; manager: CursorCliManager }) => {
    manager.on("submissionUnconfirmed", () => markSubmissionUnconfirmed(tabId));
    manager.on("session", (session) => void scheduleNativeSessionSwitch("cursor", tabId, manager, session));
    manager.on("turnCompleted", async (event: any) => {
      try {
        if (event.origin === "queue") return;
        const tab = await storage.getTabMeta(tabId);
        if (tab.session.provider !== "cursor" || tab.session.threadId !== event.threadId) return;
        const bundle = await storage.readTab(tabId);
        if (bundle.runtime.runner.activeTurnId === event.turnId) return;
        await recordTurn(storage, tabId, { threadId: event.threadId, turn: event.turn, items: event.items, origin: "manual" });
        // A manual turn that finished is proof the agent is working.
        if (String(event.turn?.status ?? "") === "completed") {
          await clearRunnerFailure(storage, tabId);
          await emitSnapshot(tabId);
        }
      } catch { /* explicit history sync can reconstruct the transcript later */ }
    });
  });

  const emitSnapshot = async (tabId: string): Promise<void> => {
    try { emit(tabId, { type: "snapshot", data: await readClientTab(tabId) }, true); }
    catch { /* the tab may have been deleted while a restore was finishing */ }
  };

  const issueHookLease = (provider: "codex" | "claude" | "cursor", tabId: string) => {
    const lease = { nonce: randomUUID(), secret: randomBytes(32).toString("base64url") };
    hookLeases.set(`${provider}:${tabId}`, lease);
    return lease;
  };
  const revokeHookLease = (provider: "codex" | "claude" | "cursor", tabId: string): void => {
    hookLeases.delete(`${provider}:${tabId}`);
  };
  const hookAuthorized = (provider: "codex" | "claude" | "cursor", tabId: string, nonce: string, authorization: unknown): boolean => {
    const lease = hookLeases.get(`${provider}:${tabId}`);
    return Boolean(lease && lease.nonce === nonce && authorization === `Bearer ${lease.secret}`);
  };

  const codexHookUrl = (tabId: string, nonce: string): string => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : Number(process.env.PORT ?? 4317);
    return `http://127.0.0.1:${port}/hooks/codex/${encodeURIComponent(tabId)}/${encodeURIComponent(nonce)}`;
  };

  const claudeHookUrl = (tabId: string, nonce: string): string => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : Number(process.env.PORT ?? 4317);
    return `http://127.0.0.1:${port}/hooks/claude/${encodeURIComponent(tabId)}/${encodeURIComponent(nonce)}`;
  };

  const cursorHookUrl = (tabId: string, nonce: string): string => {
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : Number(process.env.PORT ?? 4317);
    return `http://127.0.0.1:${port}/hooks/cursor/${encodeURIComponent(tabId)}/${encodeURIComponent(nonce)}`;
  };

  const startCodexNativeTui = async (
    tabId: string,
    cwd: string,
    launch: { mode: "new" } | { mode: "resume"; sessionId: string },
  ) => {
    const lease = issueHookLease("codex", tabId);
    try {
      const manager = codexTui.get(tabId);
      const theme = (await storage.readIndex()).ui.theme;
      const hookScriptPath = path.join(rootDir, "scripts", "codex-hook.mjs");
      const launcherPath = path.join(rootDir, "scripts", "launch-agent.ps1");
      await fs.access(launcherPath);
      const exitMarker = sessionExitMarker(CODEX_EXIT_MARKER);
      const processLaunch = await resolveCodexTuiLaunch(await manager.beginLaunch({
        cwd,
        launch,
        hookScriptPath,
        // Intended only for isolated hook compatibility probes. Normal use
        // keeps Codex's trust boundary intact and fails closed when untrusted.
        bypassHookTrust: process.env.CODEX_PROMPTOR_CODEX_BYPASS_HOOK_TRUST === "1",
      }));
      await restoreTerminalSize(storage, pty, tabId);
      await pty.startArgvCommand(tabId, cwd, processLaunch, launcherPath, "Codex", exitMarker, {
        CODEX_PROMPTOR_CODEX_HOOK_URL: codexHookUrl(tabId, lease.nonce),
        CODEX_PROMPTOR_HOOK_SECRET: lease.secret,
      }, theme);
      await manager.waitForStartup({
        startupError: () => pty.startupError(tabId) ?? codexHookStartupError(pty.recentOutput(tabId)),
        question: async () => codexStartupQuestion(await pty.screenText(tabId)),
        ready: async () => codexTuiReady(await pty.screenText(tabId)),
      });
      // A new conversation has no session yet, and cannot be given one: Codex
      // creates the thread when the first prompt is submitted. Reporting that
      // honestly beats waiting thirty seconds for a hook that is not coming.
      if (launch.mode === "new") return { manager, session: manager.session };
      const session = await manager.attachKnownSession({
        sessionId: launch.sessionId,
        cwd,
        transcriptPath: await rolloutFile(launch.sessionId),
        source: "resume",
      });
      return { manager, session };
    } catch (error) {
      revokeHookLease("codex", tabId);
      throw error;
    }
  };

  const startClaudeTui = async (
    tabId: string,
    cwd: string,
    launch: { mode: "new" } | { mode: "resume"; sessionId: string },
  ) => {
    const availability = await claudeVersion;
    if (!availability.available) throw new Error("CLAUDE_CLI_NOT_FOUND");
    const lease = issueHookLease("claude", tabId);
    try {
      const manager = claude.get(tabId);
      const theme = (await storage.readIndex()).ui.theme;
      const settingsPath = path.join(storage.tabDir(tabId), "cache", "claude-hooks.settings.json");
      const hookScriptPath = path.join(rootDir, "scripts", "claude-hook.mjs");
      const exitMarker = sessionExitMarker(CLAUDE_EXIT_MARKER);
      const command = await manager.beginLaunch({ cwd, launch, hookScriptPath, settingsPath, theme, exitMarker });
      await restoreTerminalSize(storage, pty, tabId);
      await pty.startCommand(tabId, cwd, command, "Claude Code", exitMarker, {
        CODEX_PROMPTOR_CLAUDE_HOOK_URL: claudeHookUrl(tabId, lease.nonce),
        CODEX_PROMPTOR_HOOK_SECRET: lease.secret,
      }, theme);
      const session = await manager.waitForSession(30_000, () => pty.startupError(tabId));
      if (launch.mode === "resume" && session.sessionId !== launch.sessionId) {
        throw new Error(`CLAUDE_RESUME_ID_MISMATCH:${launch.sessionId}:${session.sessionId}`);
      }
      return { manager, session };
    } catch (error) {
      revokeHookLease("claude", tabId);
      throw error;
    }
  };

  const startCursorTui = async (
    tabId: string,
    cwd: string,
    launch: { mode: "new" } | { mode: "resume"; sessionId: string },
  ) => {
    const availability = await cursorVersion;
    if (!availability.available) throw new Error("CURSOR_CLI_NOT_FOUND");
    const lease = issueHookLease("cursor", tabId);
    try {
      await ensureCursorHookBridge(rootDir, storage.backupsDir);
      const manager = cursor.get(tabId);
      manager.beginLaunch(cwd);
      const theme = (await storage.readIndex()).ui.theme;
      await restoreTerminalSize(storage, pty, tabId);
      const exitMarker = sessionExitMarker(CURSOR_EXIT_MARKER);
      await pty.startCommand(
        tabId,
        cwd,
        buildCursorCommand(cwd, launch, theme, exitMarker),
        "Cursor CLI",
        exitMarker,
        { CODEX_PROMPTOR_CURSOR_HOOK_URL: cursorHookUrl(tabId, lease.nonce), CODEX_PROMPTOR_HOOK_SECRET: lease.secret },
        theme,
      );
      const session = await manager.waitForSession(30_000, () => pty.startupError(tabId));
      if (launch.mode === "resume" && session.sessionId !== launch.sessionId) {
        throw new Error(`CURSOR_RESUME_ID_MISMATCH:${launch.sessionId}:${session.sessionId}`);
      }
      return { manager, session };
    } catch (error) {
      revokeHookLease("cursor", tabId);
      throw error;
    }
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

  const syncCodexNativeHistory = async (tabId: string, sessionId: string, transcriptPath?: string | null) => {
    const thread = await readCodexRolloutThread(sessionId, transcriptPath);
    if (!thread) return { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
    return syncHistory(storage, tabId, thread, { mode: "merge" });
  };

  const performClaudeTerminalReopen = async (tab: TabMeta, recorder: PhaseRecorder = createPhaseRecorder()): Promise<TerminalReopenResult> => {
    const tabId = tab.id;
    try {
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await codexTui.stop(tabId);
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
      const { manager, session } = await recorder.step("start", () => startClaudeTui(tabId, tab.session.workingDirectory!, { mode: "resume", sessionId: tab.session.threadId! }));
      await recorder.step("history", () => syncClaudeHistory(storage, tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath));
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
      revokeHookLease("claude", tabId);
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

  const performCursorTerminalReopen = async (tab: TabMeta, recorder: PhaseRecorder = createPhaseRecorder()): Promise<TerminalReopenResult> => {
    const tabId = tab.id;
    try {
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await codexTui.stop(tabId);
      await cursor.stop(tabId);
      await claude.stop(tabId);
      await tuiProxy.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({ ...current, session: { ...current.session, state: "connecting", lastError: null }, updatedAt: now }));
      await emitSnapshot(tabId);
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
      const { manager, session } = await recorder.step("start", () => startCursorTui(tabId, tab.session.workingDirectory!, { mode: "resume", sessionId: tab.session.threadId! }));
      await recorder.step("history", () => syncCursorHistoryIfAvailable(tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath));
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
      revokeHookLease("cursor", tabId);
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
  const performShellTerminalReopen = async (tab: TabMeta, recorder: PhaseRecorder = createPhaseRecorder()): Promise<TerminalReopenResult> => {
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
    await recorder.step("start", async () => pty.startShell(tab.id, cwd, (await storage.readIndex()).ui.theme));
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, state: "ready", reopenOnLaunch: true, connectedAt: isoNow(), lastError: null },
      updatedAt: isoNow(),
    }));
    await clearSessionNotReadyError(storage, tab.id);
    return { ok: true, bundle: await readClientTab(tab.id) };
  };

  /**
   * The thread a reopen should resume, and the tab rebound onto it when the
   * stored one turns out to have no rollout. Codex writes nothing for a thread
   * until its first prompt, so a `thread/start` that never received one leaves
   * an id that cannot survive a restart; the conversation is still on disk
   * under the thread that switch left behind.
   */
  const resolveCodexResumeThread = async (tab: TabMeta): Promise<string> => {
    const threadId = tab.session.threadId!;
    const fallbackThreadId = tab.session.lastThreadSwitch?.fromThreadId ?? null;
    const choice = chooseResumeThread({
      threadId,
      fallbackThreadId,
      threadHasRollout: Boolean(await rolloutFile(threadId)),
      fallbackHasRollout: fallbackThreadId ? Boolean(await rolloutFile(fallbackThreadId)) : false,
    });
    if (!choice.fellBack) return threadId;
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, threadId: choice.threadId, sessionId: choice.threadId },
      updatedAt: isoNow(),
    }));
    return choice.threadId;
  };

  const performCodexNativeTerminalReopen = async (tab: TabMeta, recorder: PhaseRecorder = createPhaseRecorder()): Promise<TerminalReopenResult> => {
    const tabId = tab.id;
    try {
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await codexTui.stop(tabId);
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
      const resumeThreadId = await resolveCodexResumeThread(tab);
      const { manager, session } = await recorder.step("start", () => startCodexNativeTui(
        tabId,
        tab.session.workingDirectory!,
        { mode: "resume", sessionId: resumeThreadId },
      ));
      // Only a new conversation comes back without one, and this is a resume.
      if (!session) throw new Error("CODEX_RESUME_SESSION_MISSING");
      const historyError = await recorder.step("history", async (): Promise<string | null> => {
        try {
          await syncCodexNativeHistory(tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath);
          return null;
        } catch (error) { return error instanceof Error ? error.message : String(error); }
      });
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          ...current.session,
          provider: "codex",
          state: "ready",
          reopenOnLaunch: true,
          threadId: session.sessionId,
          sessionId: session.sessionId,
          connectedAt: isoNow(),
          lastError: historyError ? { code: "HISTORY_SYNC_FAILED", message: historyError } : null,
        },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      const bundle = await readClientTab(tabId);
      emit(tabId, { type: "snapshot", data: bundle }, true);
      return { ok: true, bundle };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A question nobody answered is not a broken conversation. Stopping the
      // terminal here is what removed the prompt from under the reader, so the
      // Codex still showing it keeps running, keeps its hook lease, and stays
      // writable; answering it and reopening then connects.
      const unanswered = codexStartupQuestionFrom(message);
      const display = codexHookFailureText(message) ?? message;
      if (unanswered) {
        try {
          await storage.updateTab(tabId, (current) => ({
            ...current,
            session: { ...current.session, state: "connecting", lastError: { code: "CODEX_STARTUP_QUESTION", message: display } },
            updatedAt: isoNow(),
          }));
        } catch { /* missing tab */ }
        await emitSnapshot(tabId);
        return { ok: false, statusCode: 409, code: "CODEX_STARTUP_QUESTION", message: display };
      }
      await pty.stop(tabId, false).catch(() => undefined);
      await codexTui.stop(tabId).catch(() => undefined);
      revokeHookLease("codex", tabId);
      await updateTerminalRuntime(storage, tabId, { state: "stopped", appServer: null }).catch(() => undefined);
      const activeWriter = isActiveWriterError(message);
      const code = activeWriter ? "SESSION_ACTIVE_WRITER" : "TERMINAL_REOPEN_FAILED";
      try {
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: { ...current.session, state: "closed", lastError: { code, message: display } },
          updatedAt: isoNow(),
        }));
      } catch { /* missing tab */ }
      await emitSnapshot(tabId);
      return { ok: false, statusCode: activeWriter ? 409 : 500, code, message: display };
    }
  };

  /**
   * Subscribes to a thread without holding up the tab that owns it.
   *
   * It still has to be visible: a subscription that never landed leaves a tab
   * that looks fine but cannot run anything, so a failure is surfaced the same
   * way any other session error is. The rejected attempt is kept, so the
   * queue's first dispatch fails with this reason rather than hanging. The time
   * it took goes to the same log as the restore phases -- it is off the
   * critical path, not unmeasured.
   */
  const subscribeInBackground = (tab: TabMeta, rpc: CodexRpcClient): void => {
    const startedAt = Date.now();
    void rpc.subscribeThread(tab.session.threadId!, tab.session.workingDirectory!).then(
      () => logSubscription(tab, Date.now() - startedAt, null),
      async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        await logSubscription(tab, Date.now() - startedAt, message);
        try {
          await storage.updateTab(tab.id, (current) => ({
            ...current,
            session: { ...current.session, lastError: { code: "THREAD_SUBSCRIBE_FAILED", message } },
            updatedAt: isoNow(),
          }));
          await emitSnapshot(tab.id);
        } catch { /* a missing tab has nothing left to report against */ }
      },
    );
  };

  const logSubscription = (tab: TabMeta, ms: number, error: string | null): Promise<void> => appendRestoreTimings(
    path.join(storage.dataDir, "restore-timings.log"),
    [`  subscribe ${formatDuration(ms).padStart(7)}  ${tab.name}${error ? ` [failed] ${error}` : ""}`],
  );

  const performTerminalReopen = async (tabId: string, recorder: PhaseRecorder = createPhaseRecorder()): Promise<TerminalReopenResult> => {
    try {
      await awaitThreadSwitch(tabId);
      const tab = await storage.getTabMeta(tabId);
      if (tab.session.provider === "claude") return performClaudeTerminalReopen(tab, recorder);
      if (tab.session.provider === "cursor") return performCursorTerminalReopen(tab, recorder);
      if (tab.session.provider === "shell") return performShellTerminalReopen(tab, recorder);
      if (codexConnectionMode === "pty-hooks") return performCodexNativeTerminalReopen(tab, recorder);
      if (!tab.session.threadId || !tab.session.workingDirectory) {
        return { ok: false, statusCode: 400, code: "SESSION_NOT_READY", message: "This tab has no active session." };
      }
      await pty.stop(tabId, false);
      await codexTui.stop(tabId);
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
      const rpc = await recorder.step("appServer", () => manager.ensureReady());
      await rememberAppServer(storage, tabId, manager);
      const theme = (await storage.readIndex()).ui.theme;
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null });
      const tuiUrl = await startTuiProxy(tabId, manager);
      await restoreTerminalSize(storage, pty, tabId);
      const resumeThreadId = await resolveCodexResumeThread(tab);
      await recorder.step("pty", () => pty.start(tabId, tab.session.workingDirectory!, tuiUrl, { mode: "resume", threadId: resumeThreadId }, theme));
      await recorder.step("threadLoaded", () => waitForThreadLoaded(rpc, tab.session.threadId!, 30_000, 200, () => pty.startupError(tabId)));
      // thread/resume ships the whole conversation back and took eleven seconds
      // on the two largest here, but nothing on screen needs it: the terminal is
      // the TUI's own and history comes off the rollout. Only dispatching a turn
      // does, and CodexRpcClient makes that wait. So the tab opens now and the
      // subscription lands behind it.
      subscribeInBackground(tab, rpc);
      // Best effort, deliberately. Nothing the conversation needs to work
      // depends on this: the terminal is the TUI's own and the queue talks to
      // the App Server. Failing the whole reopen over it left a usable session
      // marked closed -- and because an oversized thread/read is remembered,
      // every retry failed at once, so the conversation could not be opened at
      // all. It is reported instead, and everything else carries on.
      const historyError = await recorder.step("history", async (): Promise<string | null> => {
        try {
          await syncHistory(storage, tabId, await readCodexThreadForHistory(rpc, tab.session.threadId!, cachedRollout(tabId)));
          return null;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", reopenOnLaunch: true, connectedAt: isoNow(), lastError: null },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      if (historyError) {
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: { ...current.session, lastError: { code: "HISTORY_SYNC_FAILED", message: historyError } },
          updatedAt: isoNow(),
        }));
      }
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
  const reopenTerminal = (tabId: string, recorder?: PhaseRecorder): Promise<TerminalReopenResult> => {
    const existing = reopenTasks.get(tabId);
    // A caller that arrives while a reopen is already running joins it; its
    // recorder would only time somebody else's work, so it is dropped.
    if (existing) return existing;
    const task = performTerminalReopen(tabId, recorder);
    reopenTasks.set(tabId, task);
    void task.then(() => {
      if (reopenTasks.get(tabId) === task) reopenTasks.delete(tabId);
    });
    return task;
  };

  let restoreOpenSessionsPromise: Promise<RestoreOpenSessionsSummary> | null = null;
  const restoreOpenSessions = (): Promise<RestoreOpenSessionsSummary> => {
    if (restoreOpenSessionsPromise) return restoreOpenSessionsPromise;
    restoreOpenSessionsPromise = (async (): Promise<RestoreOpenSessionsSummary> => {
      const startedAt = Date.now();
      const tabs = await storage.listTabMeta();
      const names = new Map(tabs.map((tab) => [tab.id, tab] as const));
      const plan = restoreOrder(tabs, startupOpenTabIds, lastSelectedTabId);
      const restored: string[] = [];
      const failed: RestoreOpenSessionsSummary["failed"] = [];
      const traces: RestoreTrace[] = [];
      const queue = runRestoreQueue(plan, RESTORE_STAGGER_MS, async (tabId) => {
        const recorder = createPhaseRecorder();
        const result = await reopenTerminal(tabId, recorder);
        if (result.ok) restored.push(tabId);
        else failed.push({ tabId, code: result.code, message: result.message });
        const tab = names.get(tabId);
        traces.push({
          tabId,
          name: tab?.name ?? tabId,
          provider: tab?.session.provider ?? "unknown",
          ok: result.ok,
          phases: recorder.phases(),
          totalMs: recorder.totalMs(),
        });
      });
      restoreQueue = queue;
      await queue.done;
      restoreQueue = null;
      await timers.start();
      return { restored, failed, timings: formatRestoreTimings(traces, Date.now() - startedAt, RESTORE_STAGGER_MS) };
    })();
    return restoreOpenSessionsPromise;
  };

  /**
   * Says so when a running turn has stopped recording anything.
   *
   * Codex can abandon a turn without ending it -- no completion, no abort, the
   * rollout simply stops -- and waitForTurn's deadline is twenty-four hours, so
   * the queue would sit on "running" for a day with nothing to show for it.
   * The rollout's last write is the signal because it is Codex's own record,
   * written whichever client it is talking to; our notifications can be routed
   * to the TUI instead of here, so a quiet socket proves nothing.
   *
   * Reporting only. A single long command legitimately records nothing while it
   * runs, so nothing is interrupted and no state is changed on this account.
   */
  const rolloutPaths = new Map<string, string>();
  /**
   * How large a rollout was when it was last seen to change, and when that was.
   *
   * The size, not the modification time. Windows does not push a file's
   * last-write time to the directory entry while a handle stays open for
   * appending, and Codex holds the rollout open for the life of the session:
   * one measured here was still reporting 05:02 fifty minutes after its last
   * record was written at 05:51. `stat` reads the size from the file itself and
   * it was exact to the byte, so growth is the signal and the clock is ours.
   */
  const rolloutProgress = new Map<string, RolloutProgress>();
  const rolloutFile = async (threadId: string): Promise<string | null> => {
    const known = rolloutPaths.get(threadId);
    if (known) return known;
    const found = await locateCodexRollout(threadId).catch(() => null);
    if (found) rolloutPaths.set(threadId, found);
    return found;
  };
  const lastRolloutGrowth = async (threadId: string, nowMs: number): Promise<number | null> => {
    try {
      const file = await rolloutFile(threadId);
      if (!file) return null;
      const progress = noteRolloutSize(rolloutProgress.get(threadId), (await fs.stat(file)).size, nowMs);
      rolloutProgress.set(threadId, progress);
      return progress.seenAtMs;
    } catch {
      // A path that stopped resolving is looked up again next sweep rather
      // than cached as broken.
      rolloutPaths.delete(threadId);
      return null;
    }
  };
  const sweepStalledTurns = async (): Promise<void> => {
    const now = Date.now();
    for (const tab of await storage.listTabMeta()) {
      if (tab.session.provider !== "codex" || !tab.session.threadId) continue;
      let runtime: RuntimeFile;
      try { runtime = await storage.readRuntime(tab.id); } catch { continue; }
      // A prompt that was dispatched and never became a turn belongs to the
      // submission recovery, not to the rollout: that file may well be growing
      // from something else entirely -- a turn the reader typed by hand, as it
      // was here -- and reading that as progress would clear the one notice
      // saying anything is wrong.
      if (runtime.runner.activePromptId && !runtime.runner.activeTurnId) continue;
      const working = Boolean(runtime.runner.activeTurnId) && runnerIsWorking(runtime.runner.state);
      const lastProgressAtMs = working ? await lastRolloutGrowth(tab.session.threadId, now) : null;
      const decision = decideStall({
        working,
        lastProgressAtMs,
        stalledSince: runtime.runner.stalledSince,
        nowMs: now,
      });
      // A quiet rollout is the same picture whether the turn died or finished
      // without us hearing about it, and the two need opposite responses. The
      // rollout says which: if the turn is recorded as finished there, the
      // completion notification was simply lost -- observed on a turn that
      // completed on disk at 05:51 and still had the queue on "running" at
      // 06:03 -- so it is handed to whatever is waiting for it, and the queue
      // carries on through its own path rather than being nudged from outside.
      if (working && decision.action === "mark") {
        const settled = await settleTurnFromRollout(tab.id, tab.session.threadId, runtime.runner.activeTurnId!).catch(() => false);
        if (settled) continue;
      }
      if (decision.action === "mark") {
        // A stall leaves nothing behind anywhere: no terminal event in the
        // rollout, no error record, and ~/.codex/log is empty. Whatever the App
        // Server said for itself is the only account there is, so it is kept
        // where it can be read after the fact.
        const said = codex.existing(tab.id)?.recentOutput().trim() ?? "";
        void appendBoundedLines(path.join(storage.dataDir, "stalled-turns.log"), [
          `${tab.name}  turn ${runtime.runner.activeTurnId}  quiet since ${decision.since}`,
          `  rollout ${rolloutPaths.get(tab.session.threadId) ?? "?"}`,
          ...(said ? said.split("\n").slice(-12).map((line) => `  app-server: ${line}`) : ["  app-server: (said nothing)"]),
        ], 300);
      }
      if (decision.action === "none") continue;
      await storage.withTabLock(tab.id, async () => {
        const bundle = await storage.readTab(tab.id);
        // Re-read under the lock: the turn may have completed while the stat ran.
        if (bundle.runtime.runner.activeTurnId !== runtime.runner.activeTurnId) return;
        const stalledSince = decision.action === "mark" ? decision.since : null;
        if (bundle.runtime.runner.stalledSince === stalledSince) return;
        await storage.writeRuntime(tab.id, RuntimeFileSchema.parse({
          ...bundle.runtime,
          runner: { ...bundle.runtime.runner, stalledSince },
          revision: bundle.runtime.revision + 1,
        }));
      });
    }
  };
  /**
   * Delivers a completion the notification never carried.
   *
   * Codex can route a turn's completion to the interactive TUI client instead
   * of this one -- waitForTurn already works around that with a summary poll,
   * but the App Server's summary can stay unsettled while the TUI drives the
   * same thread, and then nothing ever looks at the rollout. The rollout is the
   * append-only record and it says plainly that the turn is over.
   */
  const settleTurnFromRollout = async (tabId: string, threadId: string, turnId: string): Promise<boolean> => {
    const manager = codex.existing(tabId);
    const file = await rolloutFile(threadId);
    if (!manager || !file || !manager.rpc.isAwaitingTurn(turnId)) return false;
    const thread = await readCodexRolloutCached(file, threadId, storage.historyCachePath(tabId));
    const turn = thread.turns.find((item) => item.id === turnId);
    if (!turn || turn.status === "running") return false;
    return manager.rpc.settleTurnFromRecord(threadId, turn, turn.items);
  };

  const stallTimer = setInterval(() => { void sweepStalledTurns().catch(() => undefined); }, TURN_STALL_POLL_MS);
  stallTimer.unref?.();

  // Sealed buckets are appended once a minute, off the hot path. `unref` so a
  // measurement timer never keeps the process alive on its own.
  const flushTraffic = async (): Promise<void> => {
    if (!trafficLoggingEnabled) return;
    // Sample before draining: a connection open for hours would otherwise
    // contribute nothing until it closed, and then land in the wrong minute.
    for (const client of clients) sampleConnectionWire(client);
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

  app.promptor = { storage, codex, codexTui, codexConnectionMode, claude, cursor, pty, runners, timers, ui, traffic, documents, token, restoreOpenSessions, close: async () => {
    clearInterval(stallTimer);
    if (trafficFlushTimer) clearInterval(trafficFlushTimer);
    if (trafficPruneTimer) clearInterval(trafficPruneTimer);
    // Seal the minute in progress so a restart does not lose it.
    await trafficLog.append(ledger.drain(Date.now() + 60_000)).catch(() => undefined);
    await timers.stop();
    ui.stop();
    rawBatcher.close(false);
    projectionScheduler.close();
    for (const timer of terminalResyncTimers.values()) clearTimeout(timer);
    terminalResyncTimers.clear();
    await directoryPicker.stop();
    if (restoreOpenSessionsPromise) await Promise.allSettled([restoreOpenSessionsPromise]);
    await Promise.allSettled([...reopenTasks.values()]);
    // Restores now finish before their subscriptions do, so shutting down has
    // to wait for those too or a resume is killed mid-flight.
    await Promise.allSettled(codex.pendingSubscriptions());
    await Promise.allSettled([...threadSwitches.values()]);
    await recordOpenSessionsForNextLaunch(storage);
    if (lastSelectedTabId) {
      await storage.updateIndex((current) => ({ ...current, ui: { ...current.ui, lastSelectedTabId } })).catch(() => undefined);
    }
    await runners.stopAll();
    await pty.stopAll();
    await tuiProxy.stopAll();
    await cursor.stopAll();
    await claude.stopAll();
    await codexTui.stopAll();
    await codex.stopAll();
    hookLeases.clear();
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
  // The HTTP counterpart of the redaction in sendClient. preSerialization sees
  // the object before it becomes JSON, which is the last point at which a tab
  // is still a tab rather than a string to search.
  app.addHook("preSerialization", async (request, _reply, payload) => {
    const scope = classifyNetworkScope(request.raw.socket?.remoteAddress, request.headers.host);
    return redactForScope(payload, scope);
  });

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
    const scope = classifyNetworkScope(request.raw.socket?.remoteAddress, request.headers.host);
    recordTraffic("out", "http", `${request.method} ${route} ${reply.statusCode}`, wire, { rawBytes: headerBytes(reply) + body, scope });

    const requestBytes = Number(request.headers["content-length"]);
    if (Number.isFinite(requestBytes) && requestBytes > 0) {
      recordTraffic("in", "http", `${request.method} ${route}`, requestBytes, { scope });
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
        // Below this a message is sent uncompressed. At 1024 the tunnel's main
        // traffic fell entirely underneath it: 80% of projection deltas over a
        // measured hour were under 1KiB, so that link ran at 1.53x while the
        // local one -- which carries a few large snapshots -- reached 3.12x.
        // The bench puts 512 at 1.6-1.9x on exactly those shapes. Tune with
        // CODEX_PROMPTOR_WS_DEFLATE_THRESHOLD to A/B it against real traffic.
        threshold: boundedInteger(process.env.CODEX_PROMPTOR_WS_DEFLATE_THRESHOLD, 0, 65_536, 512),
        zlibDeflateOptions: { level: 3, memLevel: 7 },
      } : false,
    },
  });

  // Native CLI hooks use a per-terminal nonce plus a short-lived bearer secret.
  // The secret is inherited only by that child process and never appears in a
  // URL, proxy log or browser state. Reopening a terminal invalidates the old
  // lease immediately.
  app.post("/hooks/codex/:tabId/:nonce", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    if (!hookAuthorized("codex", tabId, String((request.params as any).nonce), request.headers.authorization)) return reply.code(401).send();
    const manager = codexTui.existing(tabId);
    if (!manager) return reply.code(410).send();
    try {
      await manager.handleHook(request.body ?? {});
      return reply.code(204).send();
    } catch (error) {
      emit(tabId, { type: "error", error: { code: "CODEX_HOOK_FAILED", message: error instanceof Error ? error.message : String(error) } });
      return reply.code(400).send();
    }
  });

  app.post("/hooks/claude/:tabId/:nonce", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    if (!hookAuthorized("claude", tabId, String((request.params as any).nonce), request.headers.authorization)) return reply.code(401).send();
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

  app.post("/hooks/cursor/:tabId/:nonce", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    if (!hookAuthorized("cursor", tabId, String((request.params as any).nonce), request.headers.authorization)) return reply.code(401).send();
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

  app.get("/api/health", async (_request, reply) => reply.send({ data: { ok: true, codex: codex.status, codexConnectionMode, claude: await claudeVersion, cursor: await cursorVersion } }));

  app.get("/api/common-prompts", async (request, reply) => {
    try { return sendRevalidatable(request, reply, await storage.readCommonPrompts()); }
    catch (error) { return sendAuxiliaryError(reply, error, "COMMON_PROMPTS_READ_FAILED"); }
  });

  app.put("/api/common-prompts", { bodyLimit: MAX_AUXILIARY_FILE_BYTES }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const result = await storage.withCommonPromptLock(async () => {
        const current = await storage.readCommonPrompts();
        assertWritePrecondition(request.headers["if-match"], entityTag(JSON.stringify({ data: current })));
        const rawItems = Array.isArray((request.body as any)?.items) ? (request.body as any).items : null;
        if (!rawItems) throw new AuxiliaryRequestError(422, "INVALID_COMMON_PROMPTS", "items must be an array.");
        if (rawItems.length > MAX_COMMON_PROMPTS) throw new AuxiliaryRequestError(422, "COMMON_PROMPT_LIMIT_REACHED", "Too many common prompts.");
        const ids = new Set<string>();
        const items = rawItems.map((raw: any) => {
          const id = typeof raw?.id === "string" && raw.id ? raw.id : randomUUID();
          if (ids.has(id)) throw new AuxiliaryRequestError(422, "DUPLICATE_COMMON_PROMPT_ID", "Common prompt ids must be unique.");
          ids.add(id);
          const title = String(raw?.title ?? "").trim();
          const text = String(raw?.text ?? "");
          if (!text.trim()) throw new AuxiliaryRequestError(422, "INVALID_COMMON_PROMPT", "Common prompt text cannot be blank.");
          return { id, title, text };
        });
        const file = CommonPromptFileSchema.parse({ schemaVersion: 1, updatedAt: isoNow(), items });
        await storage.writeCommonPrompts(file);
        return file;
      });
      const etag = entityTag(JSON.stringify({ data: result }));
      return reply.header("ETag", etag).send({ data: result });
    } catch (error) { return sendAuxiliaryError(reply, error, "COMMON_PROMPTS_WRITE_FAILED"); }
  });

  app.get("/api/tabs/:tabId/timers", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    try {
      const { file } = await timers.getTimers(tabId);
      return sendRevalidatable(request, reply, file);
    } catch (error) { return sendTimerError(reply, error); }
  });

  app.post("/api/tabs/:tabId/timers", { bodyLimit: MAX_TIMER_REQUEST_BYTES }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const result = await timers.createTimer(String((request.params as any).tabId), request.body, request.headers["if-match"]);
      return reply.header("ETag", result.etag).send({ data: { timer: result.timer, file: result.file } });
    } catch (error) { return sendTimerError(reply, error); }
  });

  app.put("/api/tabs/:tabId/timers/:timerId", { bodyLimit: MAX_TIMER_REQUEST_BYTES }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const params = request.params as any;
      const result = await timers.updateTimer(String(params.tabId), String(params.timerId), request.body, request.headers["if-match"]);
      return reply.header("ETag", result.etag).send({ data: { timer: result.timer, file: result.file } });
    } catch (error) { return sendTimerError(reply, error); }
  });

  app.delete("/api/tabs/:tabId/timers/:timerId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const params = request.params as any;
      const result = await timers.deleteTimer(String(params.tabId), String(params.timerId), request.headers["if-match"]);
      return reply.header("ETag", result.etag).code(204).send();
    } catch (error) { return sendTimerError(reply, error); }
  });

  app.post("/api/tabs/:tabId/timers/:timerId/run-now", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !UUID_RE.test(key)) return apiError(reply, 400, "INVALID_IDEMPOTENCY_KEY", "Send a UUID Idempotency-Key header.");
    try {
      const params = request.params as any;
      const result = await timers.runNow(String(params.tabId), String(params.timerId), key);
      return reply.header("ETag", result.etag).code(202).send({ data: { timer: result.timer, promptIds: result.promptIds, file: result.file } });
    } catch (error) { return sendTimerError(reply, error); }
  });

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
    const observedBucketSeconds = merged.length * 60;
    return reply.send({ data: {
      // Bumped when a field changes meaning. v1 pooled every connection into
      // one total and reported rates over the minutes that happened to have
      // records, which read like a wall-clock average and was not one.
      schemaVersion: 2,
      enabled: trafficLoggingEnabled,
      generatedAt: new Date(now).toISOString(),
      requestedSeconds: Math.round(sinceMs / 1_000),
      observedBucketSeconds,
      processUptimeSeconds: Math.round(process.uptime()),
      // `bytesPerSecond` divides by the minutes that carried records, not by
      // the requested window. A service that was idle or down contributed no
      // minutes, so the two differ and only this one is a per-active-minute rate.
      rateBasis: "observed-buckets",
      window: {
        hours,
        buckets: merged.length,
        requestedSeconds: Math.round(sinceMs / 1_000),
        observedSeconds: observedBucketSeconds,
      },
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

  app.get("/api/bootstrap", async (request, reply) => {
    const index = await storage.readIndex();
    const activities: Record<string, TabActivitySummary> = {};
    await Promise.all(index.tabs.map(async (tab) => {
      try { activities[tab.id] = await storage.readTabActivity(tab.id); }
      catch { /* a concurrently deleted or incomplete tab is omitted */ }
    }));
    // Cleartext on purpose: a page cannot be asked for a key it does not know
    // it needs. The salt is here because without it the far end can derive
    // nothing, and neither it nor the fingerprint is secret.
    const encryption = await encryptionState();
    // Only a connection that will actually be challenged is told it must
    // prove itself. Loopback never is -- it is where the passphrase was typed
    // -- and a local page that waited for a proof it would never be asked for
    // would sit behind its own prompt forever.
    const mustProve = Boolean(encryption)
      && classifyNetworkScope(request.raw.socket?.remoteAddress, request.headers.host) !== "local";
    return reply.send({ data: {
      index,
      activities,
      // The salt is here because the far end derives nothing without it, and
      // it is not a secret: its job is to make a precomputed table useless,
      // not to be unknown.
      e2ee: encryption
        ? { required: mustProve, on: true, fingerprint: encryption.fingerprint, salt: encryption.salt, iterations: encryption.iterations }
        : { required: false, on: false },
      app: {
        version: "0.1.0",
        codex: codex.status,
        codexConnectionMode,
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
    if (!isLocalBrowserRequest(request.headers)) {
      return apiError(reply, 403, "DIRECTORY_DIALOG_LOCAL_ONLY", "The native folder dialog is available only from a loopback browser.");
    }
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
    const tab = await storage.createTab(
      String(body.name ?? "未命名对话").trim().slice(0, 100) || "未命名对话",
      { afterTabId: body.afterTabId ? String(body.afterTabId) : null },
    );
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
    await codexTui.stop(tabId);
    revokeHookLease("codex", tabId);
    revokeHookLease("claude", tabId);
    revokeHookLease("cursor", tabId);
    await stopAppServer(storage, codex, tabId);
    await timers.detachTab(tabId);
    try { await storage.deleteTab(tabId); }
    catch (error) {
      await timers.reattachTab(tabId).catch(() => undefined);
      return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error));
    }
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

  app.get("/api/tabs/:tabId/export.md", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!isLocalBrowserRequest(request.headers)) {
      return apiError(reply, 403, "CONVERSATION_EXPORT_LOCAL_ONLY", "Conversation export is available only from a loopback browser.");
    }
    const tabId = String((request.params as any).tabId);
    const locale = (request.query as any)?.locale === "en" ? "en" : "zh-CN";
    try {
      // Read the full persisted files before selecting the current thread, so
      // the export is complete even when the page itself uses a small window.
      const bundle = await storage.readTab(tabId);
      const records = recordsForCurrentThread(bundle);
      const visibleBundle: TabBundle = {
        ...bundle,
        prompts: { ...bundle.prompts, prompts: records.prompts },
        answers: { ...bundle.answers, answers: records.answers },
      };
      const exportedAt = new Date();
      const filename = conversationExportFilename(bundle.tab.name, exportedAt);
      return reply
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="codex-promptor-conversation.md"; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .header("X-Codex-Promptor-Filename", encodeURIComponent(filename))
        .send(buildConversationMarkdown(visibleBundle, locale, exportedAt));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = (error as NodeJS.ErrnoException)?.code === "ENOENT";
      return missing
        ? apiError(reply, 404, "TAB_NOT_FOUND", message)
        : apiError(reply, 503, "CONVERSATION_EXPORT_FAILED", message, true);
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

    // A p2p tab is the encryption switch, not a conversation, so it leaves
    // before any of the machinery below: no working directory to validate, no
    // resume id to parse, no terminal to start. Loopback only -- letting the
    // far end set the key it will be checked against is the same as having no
    // key at all.
    if (provider === "p2p") {
      if (!isLocalBrowserRequest(request.headers)) {
        return apiError(reply, 403, "E2EE_LOCAL_ONLY", "Encryption can only be set up from this machine.");
      }
      const previous = await storage.getTabMeta(tabId).catch(() => null);
      const typed = normalizePassphrase(String(body.workingDirectory ?? body.passphrase ?? ""));
      // An empty box means "keep what is already set", which is what makes
      // reopening the tab harmless. It only fails when there is nothing yet.
      const passphrase = typed ?? (previous?.session.provider === "p2p" ? previous.session.workingDirectory : null);
      if (!passphrase) return apiError(reply, 400, "E2EE_PASSPHRASE_REQUIRED", "Enter a passphrase to turn encryption on.");
      const { material } = await newKeyMaterial(passphrase);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          ...current.session,
          provider: "p2p",
          state: "ready",
          reopenOnLaunch: true,
          workingDirectory: passphrase,
          threadId: null,
          sessionId: null,
          createdAt: current.session.createdAt ?? now,
          connectedAt: now,
          lastError: null,
          lastThreadSwitch: null,
          e2ee: material,
        },
        updatedAt: now,
      }));
      await emitSnapshot(tabId);
      return reply.send({ data: { bundle: await readClientTab(tabId) } });
    }

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
      await codexTui.stop(tabId);
      await cursor.stop(tabId);
      await claude.stop(tabId);
      revokeHookLease("codex", tabId);
      revokeHookLease("claude", tabId);
      revokeHookLease("cursor", tabId);
      await stopAppServer(storage, codex, tabId);
      await storage.updateTab(tabId, (tab) => ({
        ...tab,
        session: {
          ...tab.session,
          provider,
          state: "connecting",
          workingDirectory: cwd,
          ...(mode === "resume" ? { sessionId: resumeId } : {}),
          lastError: null,
        },
        updatedAt: isoNow(),
      }));
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
          e2ee: null,
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
          e2ee: null,
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
          e2ee: null,
          },
          updatedAt: isoNow(),
        }));
        await clearSessionNotReadyError(storage, tabId);
        return reply.send({ data: { bundle: await readClientTab(tabId), report } });
      }
      if (codexConnectionMode === "pty-hooks") {
        const now = isoNow();
        await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null, appServer: null });
        const { manager, session } = await startCodexNativeTui(
          tabId,
          cwd,
          mode === "resume" ? { mode: "resume", sessionId: resumeId } : { mode: "new" },
        );
        const report = session && mode === "resume"
          ? await syncCodexNativeHistory(tabId, session.sessionId, session.transcriptPath ?? manager.session?.transcriptPath)
          : { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
        // A new conversation has no thread yet: Codex creates one when the
        // first prompt is submitted, and the SessionStart hook that follows is
        // what binds it here. Recording null rather than inventing an id keeps
        // the queue honestly disabled until there is something to queue onto.
        await storage.updateTab(tabId, (current) => ({
          ...current,
          session: {
            provider: "codex",
            state: "ready",
            reopenOnLaunch: true,
            workingDirectory: cwd,
            threadId: session?.sessionId ?? null,
            sessionId: session?.sessionId ?? null,
            createdAt: current.session.createdAt ?? now,
            connectedAt: isoNow(),
            lastError: null,
            lastThreadSwitch: null,
          e2ee: null,
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
        // Only the id is taken from this, and `resumeId` already supplies it if
        // the response does not. Reading the summary rather than the whole
        // conversation keeps opening a long thread as cheap as opening a short
        // one; its history arrives from the rollout below.
        thread = historyThreadFromResponse(await rpc.readThreadSummary(resumeId));
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
        // The resume response is the whole conversation and the only field ever
        // taken from it, `sessionId`, is already on the summary read above.
        await rpc.resumeThread(threadId, cwd);
        report = await syncHistory(storage, tabId, await readCodexThreadForHistory(rpc, threadId, cachedRollout(tabId)));
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
        e2ee: null,
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
      // See performCodexNativeTerminalReopen: an unanswered startup question
      // leaves Codex alive and waiting for a keystroke, so nothing below may
      // tear it down -- doing so is what turned "answer this" into "cannot open".
      if (codexStartupQuestionFrom(message)) {
        const question = codexHookFailureText(message) ?? message;
        try { await storage.updateTab(tabId, (tab) => ({ ...tab, session: { ...tab.session, state: "connecting", lastError: { code: "CODEX_STARTUP_QUESTION", message: question } }, updatedAt: isoNow() })); } catch { /* tab error is secondary */ }
        await emitSnapshot(tabId).catch(() => undefined);
        return apiError(reply, 409, "CODEX_STARTUP_QUESTION", question, true);
      }
      await pty.stop(tabId, false).catch(() => undefined);
      await tuiProxy.stop(tabId).catch(() => undefined);
      await codexTui.stop(tabId).catch(() => undefined);
      await cursor.stop(tabId).catch(() => undefined);
      await claude.stop(tabId).catch(() => undefined);
      if (provider !== "shell") revokeHookLease(provider, tabId);
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
      if (codexConnectionMode === "pty-hooks") {
        const manager = codexTui.existing(tabId);
        const report = await syncCodexNativeHistory(tabId, tab.session.threadId, manager?.session?.transcriptPath);
        return reply.send({ data: { report, bundle: await readClientTab(tabId) } });
      }
      const rpc = await codex.get(tabId).ensureReady();
      const thread = await readCodexThreadForHistory(rpc, tab.session.threadId, cachedRollout(tabId));
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
      // A Codex conversation that was opened but never prompted has a terminal
      // and no thread. Refusing to close it would strand the terminal.
      const openWithoutThread = tab.session.state === "ready" && pty.has(tabId);
      if (!tab.session.threadId && tab.session.provider !== "shell" && !openWithoutThread) {
        return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no active session.");
      }
      await runners.get(tabId).freeze();
      // A terminal reaches this route with no threadId at all, so narrow here
      // rather than leaning on the guard above having ruled null out.
      const codexThreadId = tab.session.provider === "codex" ? tab.session.threadId : null;
      if (codexThreadId) {
        const manager = codexConnectionMode === "pty-hooks" ? codexTui.existing(tabId) : codex.existing(tabId);
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
      await codexTui.stop(tabId);
      revokeHookLease("codex", tabId);
      revokeHookLease("claude", tabId);
      revokeHookLease("cursor", tabId);
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
        armed = bundle.tab.session.state === "ready"
          && Boolean(bundle.tab.session.threadId)
          && bundle.runtime.runner.desiredState === "armed";
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
      const body = (request.body ?? {}) as any;
      const result = await runners.get(tabId).insertNow(
        String((request.params as any).promptId),
        body.text === undefined ? undefined : String(body.text),
      );
      return reply.send({ data: { ...result, runtime: await storage.readRuntime(tabId) } });
    } catch (error) {
      return apiError(reply, 400, "PROMPT_INSERT_NOW_FAILED", error instanceof Error ? error.message : String(error));
    }
  });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const queryToken = (request.query as any)?.token;
    if (!noAuth && queryToken !== token && !isTrustedBrowserRequest(request.headers, trustedHosts)) { socket.close(1008, "Unauthorized"); return; }
    // The peer address comes from the socket and cannot be forged; the Host
    // header only splits the loopback half, because a relay on this machine
    // reaches the origin from 127.0.0.1 exactly like the local browser does.
    const netSocket = (socket as any)?._socket ?? request.raw?.socket ?? null;
    const client: Client = {
      id: traffic.register(socket),
      socket,
      stateSubscriptions: new Set(),
      terminalSubscriptions: new Map(),
      wantsIndex: false,
      wantsDetails: true,
      scope: classifyNetworkScope(netSocket?.remoteAddress, request.headers?.host),
      netSocket,
      wireOutAt: Number(netSocket?.bytesWritten ?? 0),
      wireInAt: Number(netSocket?.bytesRead ?? 0),
      payloadOut: 0,
      payloadIn: 0,
      indexRevision: null,
    };
    clients.add(client);
    ui.connect();
    // Loopback is where the passphrase was typed; it has nothing to prove.
    let pending: PendingHandshake | null = null;
    let verified = client.scope === "local";
    if (!verified) {
      void encryptionState().then((encryption) => {
        if (!encryption) { verified = true; return; }
        pending = startHandshake(encryption.master, encryption.fingerprint);
        if (socket.readyState === 1) socket.send(JSON.stringify(pending.message));
      }).catch(() => { socket.close(1011, "Encryption unavailable"); });
    }
    socket.on("close", () => {
      if (!clients.delete(client)) return;
      // A connection that lived and died between two flushes still spent bytes.
      sampleConnectionWire(client);
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
        client.payloadIn += raw.length;
        recordTraffic("in", "ws", String(message?.type ?? "unparsed"), raw.length, { scope: client.scope });
        if (!verified) {
          // One gate rather than a check in each handler: a message type added
          // later cannot forget to ask.
          if (!allowedBeforeHandshake(message?.type)) return;
          if (message.type === HANDSHAKE_PROOF) {
            if (!pending || !handshakeAnswered(pending, message.proof)) { socket.close(1008, "Encryption handshake failed"); return; }
            verified = true;
            pending = null;
            socket.send(JSON.stringify({ type: HANDSHAKE_READY }));
          }
          return;
        }
        if (message.type === "subscribe") {
          const previousRawTabs = [...client.terminalSubscriptions.entries()]
            .filter(([, stream]) => stream.mode === "raw")
            .map(([tabId]) => tabId);
          projectionScheduler.unsubscribeClient(client.id);
          client.stateSubscriptions = parseTabSubscriptions(message.tabIds);
          // A remote catch-up has no business replaying the whole ring buffer:
          // that is the 1.33MB message the ledger kept finding. The cap already
          // existed but only applied when the client asked for it, and the one
          // path that needs it most -- a reconnect -- never did.
          client.terminalSubscriptions = parseTerminalSubscriptions(
            message.terminals,
            RAW_CATCH_UP_BYTES,
          );
          // Only the selected TabView opens a terminal socket, so whatever a
          // page is watching is what it has selected. Remembered for the next
          // launch's restore order, and used right now to jump a session that
          // is still queued to the front -- the remembered value is a guess and
          // is allowed to be wrong.
          for (const tabId of client.terminalSubscriptions.keys()) {
            lastSelectedTabId = tabId;
            restoreQueue?.promote(tabId);
          }
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
                if (result === "sent") {
                  const bytes = Buffer.byteLength(payload, "utf8");
                  client.payloadOut += bytes;
                  recordTraffic("out", "ws", payload.includes('"full":true') ? "terminal.screen.full" : "terminal.screen.delta", bytes, { scope: client.scope });
                }
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
          // A page that says which revision it holds does not need the whole
          // index back. Measured on the tunnel: 51 subscribes in 95 minutes,
          // 11.8 KB each, about three quarters of everything sent that way --
          // almost none of it a change anyone had made.
          if (client.wantsIndex) {
            const index = await storage.readIndex();
            const claimed = Number((message as any).indexRevision);
            if (Number.isSafeInteger(claimed) && claimed === index.revision) {
              client.indexRevision = index.revision;
            } else {
              // Adopting the claim first lets the existing delta path answer a
              // page that is exactly one revision behind.
              if (Number.isSafeInteger(claimed)) client.indexRevision = claimed;
              sendIndex(client, index);
            }
          }
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
        } else if (message.type === "terminal.input" || message.type === TERMINAL_INPUT_COMPACT_TYPE) {
          // The compact form names its terminal by a prefix of the tab id,
          // resolved against this client's own subscriptions -- so it can only
          // ever reach a terminal the sender is already attached to.
          const compact = message.type === TERMINAL_INPUT_COMPACT_TYPE;
          const tabId = compact
            ? resolveTerminalInputHandle(message.s, client.terminalSubscriptions.keys())
            : (message.tabId ? String(message.tabId) : null);
          const stream = tabId ? client.terminalSubscriptions.get(tabId) : undefined;
          if (!tabId || !stream) {
            sendClient(client, wsError("TERMINAL_NOT_SUBSCRIBED", "Subscribe to the terminal before sending input."), "error");
            return;
          }
          if (stream.mode === "raw" && rawResponderOwners.get(tabId) !== client.id) {
            sendClient(client, wsError("TERMINAL_READ_ONLY", "Another raw terminal client owns the input and responder lease."), "error");
            return;
          }
          const data = compact && typeof message.d === "string"
            ? plainTerminalInput(message.d, transportConfig.maxInputMessageBytes)
            : decodeTerminalInput(compact ? message.b : message.dataBase64, transportConfig.maxInputMessageBytes);
          if (data === null) {
            sendClient(client, wsError("TERMINAL_INPUT_INVALID", `Terminal input must be valid Base64 and no larger than ${transportConfig.maxInputMessageBytes} bytes.`), "error");
            return;
          }
          const tab = await storage.getTabMeta(tabId);
          if (tab.session.state !== "closed") {
            rawBatcher.markInteractive(tabId);
            projectionScheduler.markInteractive(tabId);
            pty.write(tabId, data);
            if (tab.session.provider === "codex" && codexConnectionMode === "pty-hooks") codexTui.existing(tabId)?.observeTerminalInput(data);
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
          if (provider === "codex" && codexConnectionMode === "pty-hooks") codexTui.existing(event.tabId)?.observeTerminalExit(message);
          if (provider === "claude") claude.existing(event.tabId)?.observeTerminalExit(message);
          if (provider === "cursor") cursor.existing(event.tabId)?.observeTerminalExit(message);
          if (provider === "codex" || provider === "claude" || provider === "cursor") revokeHookLease(provider, event.tabId);
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

/**
 * What a reconnect may replay at most when it does not ask for less.
 *
 * The local page used to be exempt, on the reasoning that loopback bandwidth is
 * free. The cost is not bandwidth. A busy TUI writes about 8 KB/s, so the 1 MB
 * rolling buffer turns over roughly every two minutes; any resubscribe after
 * that cannot be served incrementally and replayed the whole megabyte. Measured
 * over 95 minutes on one machine: 59 such replays, 20.6 MB, one of them
 * 1.33 MB -- and the browser paints a replay a chunk per frame, so the terminal
 * visibly fast-forwards through it. Over the bound the reader gets one screen
 * snapshot instead, which is what a redrawing TUI's scrollback amounts to
 * anyway: thousands of stale partial frames.
 */
const RAW_CATCH_UP_BYTES = 64 * 1024;

export function parseTerminalSubscriptions(value: unknown, defaultCatchUpBytes: number | null = null): Map<string, TerminalStream> {
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
          : defaultCatchUpBytes !== null ? { maxCatchUpBytes: defaultCatchUpBytes } : {}),
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
  // Serializes here rather than handing Fastify an object, which means the
  // preSerialization hook never sees it -- that hook is skipped for a payload
  // that is already a string. So the redaction has to happen here too, and the
  // ETag is computed over what actually goes out: loopback and the tunnel are
  // sent different bodies and must not share a validator.
  const scope = classifyNetworkScope(request.raw.socket?.remoteAddress, request.headers.host);
  const body = JSON.stringify(redactForScope({ data }, scope));
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

/**
 * Retires a runner failure that a later turn has disproved.
 *
 * `lastError` explains why the queue stopped, and only the queue itself clears
 * it. A turn the reader drove from the terminal never goes through the queue,
 * so one old failure kept reading as "编程代理执行失败" through every manual turn
 * after it -- with the terminal, the agent and the queue all visibly healthy.
 */
async function clearRunnerFailure(storage: StorageService, tabId: string): Promise<void> {
  await storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    const runner = bundle.runtime.runner;
    // A queue turn in flight owns this field and clears it on its own terms.
    if (!runner.lastError || runner.activeTurnId || runner.activePromptId) return;
    const runtime = RuntimeFileSchema.parse({
      ...bundle.runtime,
      revision: bundle.runtime.revision + 1,
      runner: {
        ...runner,
        // Nothing is failing any more. The queue's own intent is not this
        // function's to change, so an idle queue stays paused, not armed.
        state: runner.state === "error" ? "paused" : runner.state,
        lastError: null,
        lastTransitionAt: isoNow(),
      },
    });
    await storage.writeRuntime(tabId, runtime);
  });
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
          // The runner this error belonged to no longer exists. Carrying it
          // across a restart left a healthy conversation reporting a failure
          // from a previous run; the prompts it touched keep their own errors.
          runner: { ...bundle.runtime.runner, desiredState: settledDesiredState(bundle.runtime.runner.desiredState), state: "paused", activePromptId: null, activeTurnId: null, lastError: null, stalledSince: null, lastTransitionAt: recoveredAt },
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
            const slashCommand = isSlashCommandPrompt(prompt.text);
            return {
              ...prompt,
              status: slashCommand ? "completed" : "interrupted",
              completedAt: recoveredAt,
              updatedAt: recoveredAt,
              error: slashCommand ? null : error,
              attempts: prompt.attempts.map((attempt) => attempt.status === "dispatching" || attempt.status === "running"
                ? { ...attempt, status: slashCommand ? "completed" : "interrupted", completedAt: recoveredAt, error: slashCommand ? null : error }
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
          if (linked.length && linked.every((prompt) => isSlashCommandPrompt(prompt.text))) {
            const before = bundle.answers.answers.length;
            bundle.answers.answers = bundle.answers.answers.filter((answer) => !(answer.threadId === threadId
              && answer.codexTurnId === turnId
              && answer.status !== "completed"));
            if (bundle.answers.answers.length !== before) answersChanged = true;
            continue;
          }
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
        const promptById = new Map(prompts.prompts.map((prompt) => [prompt.id, prompt]));
        const beforeSlashCleanup = bundle.answers.answers.length;
        bundle.answers.answers = bundle.answers.answers.filter((answer) => answer.status === "completed"
          || !isSlashCommandPrompt(promptById.get(answer.promptId)?.text ?? answer.prompt));
        if (bundle.answers.answers.length !== beforeSlashCleanup) answersChanged = true;
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

class AuxiliaryRequestError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function assertWritePrecondition(header: string | string[] | undefined, etag: string): void {
  if (header === undefined) throw new AuxiliaryRequestError(428, "PRECONDITION_REQUIRED", "Send If-Match from the latest response.");
  if (!ifMatchSatisfied(header, etag)) throw new AuxiliaryRequestError(412, "PRECONDITION_FAILED", "The list changed elsewhere. Refresh and retry.");
}

function sendTimerError(reply: FastifyReply, error: unknown) {
  reply.header("Cache-Control", "no-store");
  if (error instanceof TimerServiceError) return apiError(reply, error.statusCode, error.code, error.message);
  return sendAuxiliaryError(reply, error, "TIMER_OPERATION_FAILED");
}

function sendAuxiliaryError(reply: FastifyReply, error: unknown, fallbackCode: string) {
  reply.header("Cache-Control", "no-store");
  if (error instanceof AuxiliaryRequestError) return apiError(reply, error.statusCode, error.code, error.message);
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "PROMPT_TEXT_TOO_LARGE" || code === "AUXILIARY_FILE_TOO_LARGE" || code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return apiError(reply, 413, code, "The request is too large.");
  }
  if ((error as any)?.name === "ZodError") return apiError(reply, 422, "INVALID_AUXILIARY_DATA", error instanceof Error ? error.message : "Invalid data.");
  const missing = code === "ENOENT";
  return apiError(reply, missing ? 404 : 503, missing ? "TAB_NOT_FOUND" : fallbackCode, error instanceof Error ? error.message : String(error), !missing);
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
