import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { type Group, IndexFileSchema, isoNow, newPrompt, PromptFileSchema, RuntimeFileSchema, type RuntimeFile, type TabBundle, type TabMeta } from "../shared/schemas.js";
import type { TabActivitySummary } from "../shared/tab-activity.js";
import { AppServerPool, type AppServerManager, terminateStaleAppServer, waitForThreadLoaded } from "./codex.js";
import { DirectoryPickerBusyError, DirectoryPickerService } from "./directory-picker.js";
import { historyThreadFromResponse, recordTurn, syncHistory } from "./history.js";
import { applyNavigationOrder, deleteGroupAndUngroupTabs } from "./navigation.js";
import { PtyManager } from "./pty.js";
import { RunnerManager } from "./queue.js";
import { StorageService } from "./storage.js";
import { syncTerminalThreadSelection } from "./terminal-thread-sync.js";
import { InitialTuiThreadGate, type TuiThreadSelection, type TuiThreadSelectionHandler } from "./tui-protocol.js";
import { TuiProxyPool } from "./tui-proxy.js";
import { UiLifecycle } from "./ui-lifecycle.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Client = { socket: any; subscriptions: Set<string> };

export type RestoreOpenSessionsSummary = {
  restored: string[];
  failed: Array<{ tabId: string; code: string; message: string }>;
};

type TerminalReopenResult =
  | { ok: true; bundle: TabBundle }
  | { ok: false; statusCode: number; code: string; message: string };

export type PromptorApp = FastifyInstance & {
  promptor: {
    storage: StorageService;
    codex: AppServerPool;
    pty: PtyManager;
    runners: RunnerManager;
    ui: UiLifecycle;
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
  const tuiProxy = new TuiProxyPool();
  const directoryPicker = new DirectoryPickerService();
  const ui = new UiLifecycle(Number(process.env.CODEX_PROMPTOR_UI_GRACE_MS ?? 5_000));
  const token = process.env.CODEX_PROMPTOR_TOKEN ?? randomBytes(32).toString("hex");
  const clients = new Set<Client>();
  const sequences = new Map<string, number>();
  const pendingApprovals = new Map<string, { tabId: string; manager: AppServerManager; requestId: number | string }>();
  const threadSwitches = new Map<string, Promise<void>>();
  const noAuth = process.env.CODEX_PROMPTOR_NO_AUTH === "1";

  await storage.ensure();
  const startupOpenTabIds = tabsToRestore(await storage.listTabMeta());
  await recoverTerminalRuntime(storage);

  const emit = (tabId: string, message: Record<string, unknown>) => {
    const sequence = (sequences.get(tabId) ?? 0) + 1;
    sequences.set(tabId, sequence);
    const payload = JSON.stringify({ ...message, tabId, sequence });
    for (const client of clients) {
      if (client.subscriptions.has(tabId) && client.socket.readyState === 1) client.socket.send(payload);
    }
  };

  const runners = new RunnerManager(storage, (tabId) => codex.get(tabId), (event) => {
    if (event.type === "runtime") emit(event.tabId, { type: "runner.changed", runner: event.data });
    else if (event.type === "answer") emit(event.tabId, { type: "answer.added", answer: event.data });
    else emit(event.tabId, { type: "error", error: event.data });
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
      emit(tabId, { type: "snapshot", data: await storage.readTab(tabId) });
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : String(error);
      emit(tabId, { type: "error", error: { code: "TERMINAL_THREAD_SYNC_FAILED", message } });
      try { emit(tabId, { type: "snapshot", data: await storage.readTab(tabId) }); } catch { /* tab may have been deleted */ }
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
        const eventClientId = String(event.turn?.clientUserMessageId ?? event.turn?.clientId ?? "");
        const queueTurn = bundle.runtime.runner.activeTurnId === event.turnId
          || bundle.prompts.prompts.some((prompt) => (prompt.codexTurnId === event.turnId || (eventClientId && prompt.clientUserMessageId === eventClientId))
            && (prompt.origin === "queue" || ["dispatching", "running"].includes(prompt.status)));
        if (queueTurn) return;
        const result = await recordTurn(storage, tabId, { threadId: event.threadId, turn: event.turn, items: event.items, origin: "manual" });
        if (result.answer) emit(tabId, { type: "answer.added", answer: result.answer });
      } catch { /* manual history is reconciled by the explicit sync endpoint */ }
    });
    manager.rpc.on("serverRequest", (request: any) => {
      const requestKey = `${tabId}:${String(request.id)}`;
      pendingApprovals.set(requestKey, { tabId, manager, requestId: request.id });
      emit(tabId, { type: "approval.request", requestKey, request: { method: request.method, params: request.params } });
    });
  });
  codex.on("status", ({ tabId, aggregate }: any) => emit(tabId, { type: "service.changed", codex: aggregate }));
  codex.on("removed", ({ tabId, aggregate }: any) => {
    for (const [key, pending] of pendingApprovals) if (pending.tabId === tabId) pendingApprovals.delete(key);
    emit(tabId, { type: "service.changed", codex: aggregate });
  });

  const emitSnapshot = async (tabId: string): Promise<void> => {
    try { emit(tabId, { type: "snapshot", data: await storage.readTab(tabId) }); }
    catch { /* the tab may have been deleted while a restore was finishing */ }
  };

  const performTerminalReopen = async (tabId: string): Promise<TerminalReopenResult> => {
    try {
      await awaitThreadSwitch(tabId);
      const tab = await storage.getTabMeta(tabId);
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
      await pty.start(tabId, tab.session.workingDirectory, tuiUrl, { mode: "resume", threadId: tab.session.threadId }, theme);
      await waitForThreadLoaded(rpc, tab.session.threadId, 30_000, 200, () => pty.startupError(tabId));
      await rpc.resumeThread(tab.session.threadId, tab.session.workingDirectory);
      await syncHistory(storage, tabId, historyThreadFromResponse(await rpc.readThread(tab.session.threadId)));
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", reopenOnLaunch: true, connectedAt: isoNow(), lastError: null },
        updatedAt: isoNow(),
      }));
      await clearSessionNotReadyError(storage, tabId);
      const bundle = await storage.readTab(tabId);
      emit(tabId, { type: "snapshot", data: bundle });
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

  app.promptor = { storage, codex, pty, runners, ui, token, restoreOpenSessions, close: async () => {
    ui.stop();
    await directoryPicker.stop();
    if (restoreOpenSessionsPromise) await Promise.allSettled([restoreOpenSessionsPromise]);
    await Promise.allSettled([...reopenTasks.values()]);
    await Promise.allSettled([...threadSwitches.values()]);
    await recordOpenSessionsForNextLaunch(storage);
    await runners.stopAll();
    await pty.stopAll();
    await tuiProxy.stopAll();
    await codex.stopAll();
  } };

  const apiAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (noAuth) return;
    const header = request.headers["x-codex-promptor-token"];
    const query = (request.query as any)?.token;
    if (header !== token && query !== token && !isTrustedBrowserRequest(request.headers)) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Open http://127.0.0.1:4317/ in the local browser." } });
    }
  };

  await app.register(fastifyStatic, {
    root: path.join(rootDir, "dist", "client"),
    prefix: "/",
    decorateReply: false,
    wildcard: false,
    index: "index.html",
  });
  await app.register(fastifyWebsocket);

  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith("/api/")) await apiAuth(request, reply);
  });

  app.get("/api/health", async (_request, reply) => reply.send({ data: { ok: true, codex: codex.status } }));

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
      app: { version: "0.1.0", codex: codex.status, protocol: "app-server-json-rpc" },
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
    await tuiProxy.stop(tabId);
    await runners.remove(tabId);
    await stopAppServer(storage, codex, tabId);
    try { await storage.deleteTab(tabId); } catch (error) { return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error)); }
    return reply.send({ data: { deleted: true } });
  });

  app.get("/api/tabs/:tabId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    try { return reply.send({ data: await storage.readTab(tabId) }); }
    catch (error) { return apiError(reply, 404, "TAB_NOT_FOUND", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/tabs/:tabId/session", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const body = (request.body ?? {}) as any;
    const mode = body.mode === "resume" ? "resume" : "new";
    const cwd = await validWorkingDirectory(body.workingDirectory ?? body.cwd);
    if (!cwd) return apiError(reply, 400, "INVALID_WORKING_DIRECTORY", "Choose an existing local directory.");
    const resumeId = mode === "resume" ? String(body.resumeId ?? "") : "";
    if (mode === "resume" && !UUID_RE.test(resumeId)) return apiError(reply, 400, "INVALID_RESUME_ID", "Session id must be a UUID.");
    const previous = await storage.getTabMeta(tabId).catch(() => null);
    try {
      await awaitThreadSwitch(tabId);
      await pty.stop(tabId, false);
      await tuiProxy.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      await storage.updateTab(tabId, (tab) => ({ ...tab, session: { ...tab.session, state: "connecting", lastError: null }, updatedAt: isoNow() }));
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
        report = await syncHistory(storage, tabId, historyThreadFromResponse(await rpc.readThread(threadId)));
      }
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
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
      const bundle = await storage.readTab(tabId);
      return reply.send({ data: { bundle, report } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await pty.stop(tabId, false).catch(() => undefined);
      await tuiProxy.stop(tabId).catch(() => undefined);
      await stopAppServer(storage, codex, tabId).catch(() => undefined);
      await updateTerminalRuntime(storage, tabId, { state: "stopped" }).catch(() => undefined);
      const activeWriter = isActiveWriterError(message);
      const code = activeWriter ? "SESSION_ACTIVE_WRITER" : "SESSION_CONNECT_FAILED";
      const display = activeWriter ? "该 session 正由另一个 Codex 进程占用；请先退出外部 CLI 或其他客户端后重试。" : message;
      try { await storage.updateTab(tabId, (tab) => ({ ...tab, session: { ...tab.session, state: previous?.session.state === "closed" ? "closed" : "error", lastError: { code, message: display } }, updatedAt: isoNow() })); } catch { /* tab error is secondary */ }
      return apiError(reply, activeWriter ? 409 : 502, code, display, true);
    }
  });

  app.post("/api/tabs/:tabId/history/sync", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    try {
      await awaitThreadSwitch(tabId);
      const tab = await storage.getTabMeta(tabId);
      if (tab.session.state === "closed") return apiError(reply, 423, "CONVERSATION_CLOSED", "对话已关闭，请先重新打开终端。");
      if (!tab.session.threadId) return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no session.");
      const rpc = await codex.get(tabId).ensureReady();
      const thread = historyThreadFromResponse(await rpc.readThread(tab.session.threadId));
      const report = await syncHistory(storage, tabId, thread);
      return reply.send({ data: { report, bundle: await storage.readTab(tabId) } });
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
      const bundle = await storage.readTab(tabId);
      const tab = bundle.tab;
      if (!tab.session.threadId) return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no active session.");
      await runners.get(tabId).freeze();
      const manager = codex.existing(tabId);
      if (manager) {
        const activeTurns = manager.rpc.activeTurnIds(tab.session.threadId);
        await Promise.all(activeTurns.map((turnId) => manager.rpc.interruptTurn(tab.session.threadId!, turnId).catch(() => undefined)));
        if (activeTurns.length) await manager.rpc.waitForThreadIdle(tab.session.threadId, 5_000).catch(() => undefined);
      }
      await pty.stop(tabId);
      await tuiProxy.stop(tabId);
      await stopAppServer(storage, codex, tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", reopenOnLaunch: false, lastError: null },
        updatedAt: now,
      }));
      await updateTerminalRuntime(storage, tabId, { state: "stopped", lastExitCode: null, lastError: null, appServer: null });
      return reply.send({ data: await storage.readTab(tabId) });
    } catch (error) { return apiError(reply, 500, "CONVERSATION_CLOSE_FAILED", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/tabs/:tabId/prompts", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const body = (request.body ?? {}) as any;
    const text = String(body.text ?? "").trim();
    if (!text) return apiError(reply, 400, "PROMPT_EMPTY", "Prompt text cannot be empty.");
    try {
      const result = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertConversationOpen(bundle);
        const next = newPrompt(text, "queue");
        const beforeId = body.beforeId ? String(body.beforeId) : null;
        const afterId = body.afterId ? String(body.afterId) : null;
        const before = beforeId ? bundle.prompts.prompts.findIndex((item) => item.id === beforeId) : -1;
        const after = afterId ? bundle.prompts.prompts.findIndex((item) => item.id === afterId) : -1;
        const index = before >= 0 ? before : after >= 0 ? after + 1 : bundle.prompts.prompts.length;
        bundle.prompts.prompts.splice(index, 0, next);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await storage.writePrompts(tabId, bundle.prompts);
        return { prompt: next, autoStart: bundle.tab.session.state === "ready" && Boolean(bundle.tab.session.threadId) };
      });
      if (result.autoStart) await runners.get(tabId).start();
      return reply.send({ data: result.prompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes("对话已关闭")
        ? apiError(reply, 423, "CONVERSATION_CLOSED", message)
        : apiError(reply, 404, "TAB_NOT_FOUND", message);
    }
  });

  app.patch("/api/tabs/:tabId/prompts/:promptId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const promptId = String((request.params as any).promptId);
    const body = (request.body ?? {}) as any;
    try {
      const prompt = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertConversationOpen(bundle);
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
        await storage.writePrompts(tabId, bundle.prompts);
        return prompt;
      });
      return reply.send({ data: prompt });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return apiError(reply, message.includes("对话已关闭") ? 423 : 400, message.includes("对话已关闭") ? "CONVERSATION_CLOSED" : "PROMPT_UPDATE_FAILED", message); }
  });

  app.delete("/api/tabs/:tabId/prompts/:promptId", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const promptId = String((request.params as any).promptId);
    try {
      await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertConversationOpen(bundle);
        const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
        if (!prompt) throw new Error("PROMPT_NOT_FOUND");
        if (["completed", "running", "dispatching"].includes(prompt.status)) throw new Error("PROMPT_READ_ONLY");
        bundle.prompts.prompts = bundle.prompts.prompts.filter((item) => item.id !== promptId);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await storage.writePrompts(tabId, bundle.prompts);
      });
      return reply.send({ data: { deleted: true } });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return apiError(reply, message.includes("对话已关闭") ? 423 : 400, message.includes("对话已关闭") ? "CONVERSATION_CLOSED" : "PROMPT_DELETE_FAILED", message); }
  });

  app.put("/api/tabs/:tabId/prompts/order", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    const ids = Array.isArray((request.body as any)?.promptIds) ? (request.body as any).promptIds.map(String) : [];
    try {
      const prompts = await storage.withTabLock(tabId, async () => {
        const bundle = await storage.readTab(tabId);
        assertConversationOpen(bundle);
        const threadId = bundle.tab.session.threadId;
        const isReorderable = (item: (typeof bundle.prompts.prompts)[number]) => item.status === "pending"
          && (!item.threadId || item.threadId === threadId);
        const pending = bundle.prompts.prompts.filter(isReorderable);
        if (ids.length !== pending.length || new Set(ids).size !== ids.length || ids.some((id: string) => !pending.some((item) => item.id === id))) throw new Error("PROMPT_ORDER_INVALID");
        const byId = new Map(pending.map((item) => [item.id, item]));
        let cursor = 0;
        bundle.prompts.prompts = bundle.prompts.prompts.map((item) => isReorderable(item) ? byId.get(ids[cursor++])! : item);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await storage.writePrompts(tabId, bundle.prompts);
        return bundle.prompts;
      });
      return reply.send({ data: prompts });
    } catch (error) { const message = error instanceof Error ? error.message : String(error); return apiError(reply, message.includes("对话已关闭") ? 423 : 400, message.includes("对话已关闭") ? "CONVERSATION_CLOSED" : "PROMPT_ORDER_INVALID", message); }
  });

  app.post("/api/tabs/:tabId/runner/start", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertConversationOpen(await storage.readTab(tabId)); await runners.get(tabId).start(); return reply.send({ data: await storage.readTab(tabId) }); } catch (error) { return apiError(reply, 400, "RUNNER_START_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/runner/pause", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertConversationOpen(await storage.readTab(tabId)); await runners.get(tabId).pause(); return reply.send({ data: await storage.readTab(tabId) }); } catch (error) { return apiError(reply, 400, "RUNNER_PAUSE_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.patch("/api/tabs/:tabId/runner/config", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertConversationOpen(await storage.readTab(tabId)); const value = (request.body as any)?.onFailure; if (value !== "pause" && value !== "continue") throw new Error("onFailure must be pause or continue"); const runtime = await runners.get(tabId).configure(value); return reply.send({ data: runtime }); } catch (error) { return apiError(reply, 400, "RUNNER_CONFIG_INVALID", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/prompts/:promptId/retry", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertConversationOpen(await storage.readTab(tabId)); const runner = runners.get(tabId); await runner.retry(String((request.params as any).promptId)); await runner.start(); return reply.send({ data: await storage.readTab(tabId) }); } catch (error) { return apiError(reply, 400, "PROMPT_RETRY_FAILED", error instanceof Error ? error.message : String(error)); } });
  app.post("/api/tabs/:tabId/prompts/:promptId/skip", async (request, reply) => { try { const tabId = String((request.params as any).tabId); assertConversationOpen(await storage.readTab(tabId)); await runners.get(tabId).skip(String((request.params as any).promptId)); return reply.send({ data: await storage.readTab(tabId) }); } catch (error) { return apiError(reply, 400, "PROMPT_SKIP_FAILED", error instanceof Error ? error.message : String(error)); } });

  app.get("/ws", { websocket: true }, (socket, request) => {
    const queryToken = (request.query as any)?.token;
    if (!noAuth && queryToken !== token && !isTrustedBrowserRequest(request.headers)) { socket.close(1008, "Unauthorized"); return; }
    const client: Client = { socket, subscriptions: new Set() };
    clients.add(client);
    ui.connect();
    socket.on("close", () => {
      if (!clients.delete(client)) return;
      ui.disconnect();
    });
    socket.on("message", async (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as any;
        if (message.type === "subscribe") {
          client.subscriptions = new Set(Array.isArray(message.tabIds) ? message.tabIds.map(String) : []);
          if (message.snapshots !== false) {
            for (const tabId of client.subscriptions) {
              try {
                const data = await storage.readTab(tabId);
                socket.send(JSON.stringify({ type: "snapshot", tabId, sequence: sequences.get(tabId) ?? 0, data }));
                const terminal = pty.snapshot(tabId, message.terminals?.[tabId] ?? {});
                if (terminal) socket.send(JSON.stringify({ type: "terminal.output", tabId, sequence: sequences.get(tabId) ?? 0, ...terminal }));
              } catch { /* tab may have been deleted */ }
            }
          }
        } else if (message.type === "terminal.sync" && message.tabId) {
          const tabId = String(message.tabId);
          const terminal = pty.snapshot(tabId, message.cursor ?? {});
          if (terminal) socket.send(JSON.stringify({ type: "terminal.output", tabId, sequence: sequences.get(tabId) ?? 0, ...terminal }));
        } else if (message.type === "snapshot.request" && message.tabId) {
          const data = await storage.readTab(String(message.tabId));
          socket.send(JSON.stringify({ type: "snapshot", tabId: String(message.tabId), sequence: sequences.get(String(message.tabId)) ?? 0, data }));
        } else if (message.type === "terminal.input" && message.tabId && typeof message.dataBase64 === "string") {
          const tabId = String(message.tabId);
          if ((await storage.getTabMeta(tabId)).session.state !== "closed") pty.write(tabId, Buffer.from(message.dataBase64, "base64").toString("utf8"));
        } else if (message.type === "terminal.resize" && message.tabId) {
          const tabId = String(message.tabId);
          if ((await storage.getTabMeta(tabId)).session.state !== "closed") pty.resize(tabId, Number(message.cols), Number(message.rows));
        } else if (message.type === "approval.respond" && message.requestKey !== undefined) {
          const requestKey = String(message.requestKey);
          const pending = pendingApprovals.get(requestKey);
          if (pending) {
            pending.manager.rpc.respond(pending.requestId, message.response ?? {});
            pendingApprovals.delete(requestKey);
          }
        }
      } catch { socket.send(JSON.stringify({ type: "error", error: { code: "INVALID_WS_MESSAGE", message: "Invalid WebSocket message." } })); }
    });
  });

  pty.on("event", async (event: any) => {
    if (event.type === "output") emit(event.tabId, {
      type: "terminal.output",
      generation: event.generation,
      startOffset: event.startOffset,
      endOffset: event.endOffset,
      reset: false,
      dataBase64: event.dataBase64,
    });
    else {
      const state = event.state === "stopped" ? "stopped" : event.state === "running" ? "running" : event.state === "starting" ? "starting" : event.state === "error" ? "error" : "exited";
      try { await updateTerminalRuntime(storage, event.tabId, {
        state,
        lastExitCode: event.exitCode ?? null,
        lastError: state === "error" ? { code: "CODEX_TUI_EXITED", message: event.message ?? "Codex TUI exited unexpectedly." } : null,
      }); } catch { /* tab could be deleted */ }
      emit(event.tabId, { type: "terminal.state", state: event.state, exitCode: event.exitCode ?? null, message: event.message ?? null });
    }
  });

  return app;
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

async function clearSessionNotReadyError(storage: StorageService, tabId: string): Promise<void> {
  await storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    if (bundle.runtime.runner.lastError?.code !== "SESSION_NOT_READY") return;
    const runtime = RuntimeFileSchema.parse({
      ...bundle.runtime,
      revision: bundle.runtime.revision + 1,
      runner: {
        ...bundle.runtime.runner,
        desiredState: "paused",
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
      tab.session.threadId
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
      const runnerStale = bundle.runtime.runner.desiredState !== "paused"
        || bundle.runtime.runner.state !== "paused"
        || bundle.runtime.runner.activePromptId !== null
        || bundle.runtime.runner.activeTurnId !== null;
      if (!terminalStale && !sessionStale && !runnerStale && !staleAppServer) return;
      if (terminalStale || sessionStale || runnerStale || staleAppServer) {
        const runtime = RuntimeFileSchema.parse({
          ...bundle.runtime,
          revision: bundle.runtime.revision + 1,
          runner: { ...bundle.runtime.runner, desiredState: "paused", state: "paused", activePromptId: null, activeTurnId: null },
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
      if (sessionStale) {
        const recoveredTab = { ...bundle.tab, session: { ...bundle.tab.session, state: "closed" as const, lastError: null }, updatedAt: isoNow() };
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

function assertConversationOpen(bundle: TabBundle): void {
  if (bundle.tab.session.state === "closed") throw new Error("对话已关闭，请先重新打开终端。");
}

function isActiveWriterError(message: string): boolean {
  return /active writer|already has an active writer|thread\/resume failed.*writer/i.test(message);
}

export function isTrustedBrowserOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host || !/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(host)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function isTrustedBrowserRequest(headers: { origin?: string; referer?: string; host?: string }): boolean {
  return isTrustedBrowserOrigin(headers.origin, headers.host) || isTrustedBrowserOrigin(headers.referer, headers.host);
}
