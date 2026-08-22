import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { type Group, IndexFileSchema, isoNow, newPrompt, PromptFileSchema, RuntimeFileSchema, type TabBundle } from "../shared/schemas.js";
import { AppServerPool, type AppServerManager } from "./codex.js";
import { historyThreadFromResponse, recordTurn, syncHistory } from "./history.js";
import { applyNavigationOrder, deleteGroupAndUngroupTabs } from "./navigation.js";
import { PtyManager } from "./pty.js";
import { RunnerManager } from "./queue.js";
import { StorageService } from "./storage.js";

const execFileAsync = promisify(execFile);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Client = { socket: any; subscriptions: Set<string> };

export type PromptorApp = FastifyInstance & {
  promptor: {
    storage: StorageService;
    codex: AppServerPool;
    pty: PtyManager;
    runners: RunnerManager;
    token: string;
    close: () => Promise<void>;
  };
};

export async function createApp(rootDir: string): Promise<PromptorApp> {
  const app = Fastify({ logger: false }) as unknown as PromptorApp;
  const storage = new StorageService(rootDir);
  const codex = new AppServerPool();
  const pty = new PtyManager();
  const token = process.env.CODEX_PROMPTOR_TOKEN ?? randomBytes(32).toString("hex");
  const clients = new Set<Client>();
  const sequences = new Map<string, number>();
  const pendingApprovals = new Map<string, { tabId: string; manager: AppServerManager; requestId: number | string }>();
  const noAuth = process.env.CODEX_PROMPTOR_NO_AUTH === "1";

  await storage.ensure();
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

  app.promptor = { storage, codex, pty, runners, token, close: async () => {
    await runners.stopAll();
    await pty.stopAll();
    await codex.stopAll();
  } };

  const apiAuth = async (request: FastifyRequest, reply: FastifyReply) => {
    if (noAuth) return;
    const header = request.headers["x-codex-promptor-token"];
    const query = (request.query as any)?.token;
    if (header !== token && query !== token) return reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Open the local URL printed by start.ps1." } });
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
    return reply.send({ data: {
      index,
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

  app.post("/api/dialog/select-directory", async (_request, reply) => {
    if (process.platform !== "win32") return reply.code(400).send({ error: { code: "WINDOWS_ONLY", message: "Folder dialog is available on Windows." } });
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::Out.Write($d.SelectedPath)}";
    try {
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false, timeout: 120_000 });
      return reply.send({ data: { path: String(result.stdout).trim() || null } });
    } catch (error) {
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
    // The tab directory is moved immediately below; do not enqueue a terminal
    // runtime write that can race the directory rename on Windows.
    await pty.stop(tabId, false);
    await runners.remove(tabId);
    await codex.stop(tabId);
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
      await pty.stop(tabId, false);
      await codex.stop(tabId);
      await storage.updateTab(tabId, (tab) => ({ ...tab, session: { ...tab.session, state: "connecting", lastError: null }, updatedAt: isoNow() }));
      const manager = codex.get(tabId);
      const rpc = await manager.ensureReady();
      let thread: any;
      let report: unknown = null;
      if (mode === "resume") {
        const read = historyThreadFromResponse(await rpc.readThread(resumeId));
        report = await syncHistory(storage, tabId, read);
        thread = historyThreadFromResponse(await rpc.resumeThread(resumeId, cwd));
      } else {
        thread = historyThreadFromResponse(await rpc.startThread(cwd));
      }
      const threadId = String(thread?.id ?? thread?.threadId ?? body.resumeId ?? "");
      if (!threadId) throw new Error("THREAD_ID_MISSING");
      const now = isoNow();
      const tab = await storage.updateTab(tabId, (current) => ({
        ...current,
        session: {
          state: "ready",
          workingDirectory: cwd,
          threadId,
          sessionId: String(thread?.sessionId ?? threadId),
          createdAt: current.session.createdAt ?? now,
          connectedAt: now,
          lastError: null,
        },
        updatedAt: now,
      }));
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null });
      if (manager.remoteUrl) await pty.start(tabId, cwd, manager.remoteUrl, threadId, (await storage.readIndex()).ui.theme);
      const bundle = await storage.readTab(tabId);
      return reply.send({ data: { bundle, report } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await codex.stop(tabId).catch(() => undefined);
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
    try {
      const tab = await storage.getTabMeta(tabId);
      if (!tab.session.threadId || !tab.session.workingDirectory) return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no active session.");
      await pty.stop(tabId, false);
      await codex.stop(tabId);
      const manager = codex.get(tabId);
      const rpc = await manager.ensureReady();
      await rpc.resumeThread(tab.session.threadId, tab.session.workingDirectory);
      if (!manager.remoteUrl) throw new Error("APP_SERVER_REMOTE_URL_MISSING");
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", connectedAt: now, lastError: null },
        updatedAt: now,
      }));
      const theme = (await storage.readIndex()).ui.theme;
      await updateTerminalRuntime(storage, tabId, { state: "starting", lastStartedAt: now, lastExitCode: null, lastError: null });
      await pty.start(tabId, tab.session.workingDirectory, manager.remoteUrl, tab.session.threadId, theme);
      return reply.send({ data: await storage.readTab(tabId) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await codex.stop(tabId).catch(() => undefined);
      const activeWriter = isActiveWriterError(message);
      const code = activeWriter ? "SESSION_ACTIVE_WRITER" : "TERMINAL_REOPEN_FAILED";
      const display = activeWriter ? "该 session 正由外部 Codex 占用；请先退出外部 CLI 后重试。" : message;
      try { await storage.updateTab(tabId, (current) => ({ ...current, session: { ...current.session, state: "closed", lastError: { code, message: display } }, updatedAt: isoNow() })); } catch { /* secondary */ }
      return apiError(reply, activeWriter ? 409 : 500, code, display, true);
    }
  });

  app.post("/api/tabs/:tabId/session/close", async (request, reply) => {
    const tabId = String((request.params as any).tabId);
    try {
      const tab = await storage.getTabMeta(tabId);
      if (!tab.session.threadId) return apiError(reply, 400, "SESSION_NOT_READY", "This tab has no active session.");
      await runners.get(tabId).freeze();
      const manager = codex.existing(tabId);
      if (manager) {
        const activeTurns = manager.rpc.activeTurnIds(tab.session.threadId);
        await Promise.all(activeTurns.map((turnId) => manager.rpc.interruptTurn(tab.session.threadId!, turnId).catch(() => undefined)));
        if (activeTurns.length) await manager.rpc.waitForThreadIdle(tab.session.threadId, 5_000).catch(() => undefined);
      }
      await pty.stop(tabId);
      await codex.stop(tabId);
      const now = isoNow();
      await storage.updateTab(tabId, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", lastError: null },
        updatedAt: now,
      }));
      await updateTerminalRuntime(storage, tabId, { state: "stopped", lastExitCode: null, lastError: null });
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
        const pending = bundle.prompts.prompts.filter((item) => item.status === "pending");
        if (ids.length !== pending.length || new Set(ids).size !== ids.length || ids.some((id: string) => !pending.some((item) => item.id === id))) throw new Error("PROMPT_ORDER_INVALID");
        const byId = new Map(pending.map((item) => [item.id, item]));
        let cursor = 0;
        bundle.prompts.prompts = bundle.prompts.prompts.map((item) => item.status === "pending" ? byId.get(ids[cursor++])! : item);
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
    if (!noAuth && queryToken !== token) { socket.close(1008, "Unauthorized"); return; }
    const client: Client = { socket, subscriptions: new Set() };
    clients.add(client);
    socket.on("close", () => clients.delete(client));
    socket.on("message", async (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as any;
        if (message.type === "subscribe") {
          client.subscriptions = new Set(Array.isArray(message.tabIds) ? message.tabIds.map(String) : []);
          for (const tabId of client.subscriptions) {
            try {
              const data = await storage.readTab(tabId);
              socket.send(JSON.stringify({ type: "snapshot", tabId, sequence: sequences.get(tabId) ?? 0, data }));
              const terminal = pty.snapshot(tabId, message.terminals?.[tabId] ?? {});
              if (terminal) socket.send(JSON.stringify({ type: "terminal.output", tabId, sequence: sequences.get(tabId) ?? 0, ...terminal }));
            } catch { /* tab may have been deleted */ }
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

async function updateTerminalRuntime(storage: StorageService, tabId: string, patch: Partial<{ state: "stopped" | "starting" | "running" | "exited" | "error"; lastExitCode: number | null; lastStartedAt: string | null; lastError: { code: string; message: string } | null }>): Promise<void> {
  await storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    const runtime = RuntimeFileSchema.parse({ ...bundle.runtime, terminal: { ...bundle.runtime.terminal, ...patch }, revision: bundle.runtime.revision + 1 });
    await storage.writeRuntime(tabId, runtime);
  });
}

export async function recoverTerminalRuntime(storage: StorageService): Promise<number> {
  let recovered = 0;
  for (const tab of await storage.listTabMeta()) {
    await storage.withTabLock(tab.id, async () => {
      const bundle = await storage.readTab(tab.id);
      const terminalStale = bundle.runtime.terminal.state === "starting" || bundle.runtime.terminal.state === "running";
      const sessionStale = bundle.tab.session.state === "ready" || bundle.tab.session.state === "connecting";
      if (!terminalStale && !sessionStale) return;
      if (terminalStale || sessionStale) {
        const runtime = RuntimeFileSchema.parse({
          ...bundle.runtime,
          revision: bundle.runtime.revision + 1,
          runner: { ...bundle.runtime.runner, desiredState: "paused", state: "paused", activePromptId: null, activeTurnId: null },
          terminal: { ...bundle.runtime.terminal, state: "stopped", lastExitCode: null, lastError: null },
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
