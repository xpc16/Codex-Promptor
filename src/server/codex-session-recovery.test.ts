import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newPrompt } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";
import * as history from "./codex-history.js";
import * as tui from "./codex-tui.js";
import * as codex from "./codex.js";
import { StorageService } from "./storage.js";
import { TuiProxyPool } from "./tui-proxy.js";
import { syncTerminalThreadSelection } from "./terminal-thread-sync.js";

const a = "10000000-0000-4000-8000-000000000001";
const b = "10000000-0000-4000-8000-000000000002";
const c = "10000000-0000-4000-8000-000000000003";
let app: PromptorApp | null = null;
let root = "";
const files = new Map<string, string>();
const realFind = history.findVerifiedCodexRollout;

afterEach(async () => {
  if (app) { await app.promptor.close(); await app.close(); app = null; }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  files.clear();
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function setup(mode = "pty-hooks") {
  root = await mkdtemp(path.join(os.tmpdir(), "promptor-durable-session-"));
  await mkdir(path.join(root, "dist", "client"), { recursive: true });
  await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>fixture</title>");
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts", "launch-agent.ps1"), "# not executed");
  vi.stubEnv("CODEX_PROMPTOR_CODEX_CONNECTION_MODE", mode);
  const finder = vi.spyOn(history, "findVerifiedCodexRollout").mockImplementation(async (id) => {
    const file = files.get(id);
    return file ? realFind(id, file) : null; // never search the user's sessions
  });
  app = await createApp(root);
  await app.ready();
  return { app, finder };
}

async function rollout(id: string) {
  const file = path.join(root, `${id}.jsonl`);
  const record = (payload: object) => ({ timestamp: "2026-09-01T00:00:00.000Z", type: "event_msg", payload });
  await writeFile(file, [
    { type: "session_meta", payload: { id, source: "cli" } },
    record({ type: "task_started", turn_id: "turn-saved" }),
    record({ type: "item_completed", turn_id: "turn-saved", item: { type: "UserMessage", content: [{ type: "input_text", text: "saved prompt" }] } }),
    record({ type: "task_complete", turn_id: "turn-saved", last_agent_message: "saved answer" }),
  ].map((item) => JSON.stringify(item)).join("\n") + "\n");
  files.set(id, file);
  return file;
}

async function tabWithThread(threadId: string) {
  const storage = app!.promptor.storage;
  const tab = await storage.createTab("fixture");
  await storage.updateTab(tab.id, (current) => ({
    ...current,
    session: { ...current.session, state: "ready", workingDirectory: root, threadId, sessionId: threadId, lastDurableThreadId: undefined },
  }));
  const prompts = await storage.readPromptsOnly(tab.id);
  await storage.writePrompts(tab.id, { ...prompts, prompts: [newPrompt("keep pending")] });
  return tab;
}

describe.each(["pty-hooks", "app-server"])("%s durable session recovery", (mode) => {
  it("fails explicitly without launching anything when this tab has no recoverable history", async () => {
    const { app } = await setup(mode);
    const tab = await tabWithThread(c);
    const server = vi.spyOn(codex.AppServerManager.prototype, "ensureReady");
    const nativeStart = vi.spyOn(app.promptor.pty, "startArgvCommand");
    const remoteStart = vi.spyOn(app.promptor.pty, "start");
    const response = await app.inject({ method: "POST", url: `/api/tabs/${tab.id}/terminal/reopen`, headers: { "x-codex-promptor-token": app.promptor.token } });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toContain("CODEX_SESSION_NOT_SAVED");
    expect(server).not.toHaveBeenCalled();
    expect(nativeStart).not.toHaveBeenCalled();
    expect(remoteStart).not.toHaveBeenCalled();
    expect((await app.promptor.storage.getTabMeta(tab.id)).session).toMatchObject({ threadId: c, state: "closed" });
    expect((await app.promptor.storage.readPromptsOnly(tab.id)).prompts[0].text).toBe("keep pending");
  });

  it("preserves a durable origin across two empty switches and checkpoints the first written turn", async () => {
    const { app, finder } = await setup(mode);
    await rollout(a);
    const tab = await tabWithThread(a);
    const native = app.promptor.codexTui.get(tab.id);
    const rpc = {
      resumeThread: vi.fn().mockResolvedValue({}),
      readThreadSummary: vi.fn(async (id: string) => ({ thread: { id, cwd: root } })),
      readThread: vi.fn(async (id: string) => ({ thread: { id, cwd: root, turns: [] } })),
    };
    for (const target of [b, c]) {
      if (mode === "pty-hooks") {
        await native.handleHook({ hook_event_name: "SessionStart", session_id: target, cwd: root, source: "clear" });
      } else {
        await syncTerminalThreadSelection({
          storage: app.promptor.storage, tabId: tab.id, rpc,
          runner: { freeze: async () => undefined, start: async () => undefined },
          selection: { method: "thread/start", requestedThreadId: null, requestedCwd: root, thread: { id: target } },
        });
      }
      await vi.waitFor(async () => expect((await app.promptor.storage.getTabMeta(tab.id)).session).toMatchObject({ threadId: target, lastDurableThreadId: a }));
    }
    await rollout(c);
    const emitter = mode === "pty-hooks" ? native : app.promptor.codex.get(tab.id).rpc;
    emitter.emit("turnStarted", { threadId: c });
    await vi.waitFor(async () => expect((await app.promptor.storage.getTabMeta(tab.id)).session.lastDurableThreadId).toBe(c));
    const persisted = await new StorageService(root).getTabMeta(tab.id);
    expect(persisted.session.lastDurableThreadId).toBe(c);
    const reads = finder.mock.calls.length;
    emitter.emit("turnStarted", { threadId: c });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(finder.mock.calls.length).toBe(reads);
    expect((await app.promptor.storage.readPromptsOnly(tab.id)).prompts.some((prompt) => prompt.text === "keep pending" && prompt.status === "pending")).toBe(true);
  });

  it("uses the recovered id for launch, loading, subscription and history", async () => {
    const { app } = await setup(mode);
    const savedFile = await rollout(a);
    const tab = await tabWithThread(c);
    await app.promptor.storage.updateTab(tab.id, (current) => ({ ...current, session: { ...current.session, lastDurableThreadId: a } }));
    const begin = vi.spyOn(tui.CodexTuiManager.prototype, "beginLaunch").mockResolvedValue({ executable: "codex", args: [] });
    vi.spyOn(tui.CodexTuiManager.prototype, "waitForStartup").mockResolvedValue();
    vi.spyOn(tui, "resolveCodexTuiLaunch").mockImplementation(async (launch) => launch);
    const nativeStart = vi.spyOn(app.promptor.pty, "startArgvCommand").mockResolvedValue();
    const remoteStart = vi.spyOn(app.promptor.pty, "start").mockResolvedValue();
    vi.spyOn(codex.AppServerManager.prototype, "ensureReady").mockImplementation(async function (this: codex.AppServerManager) { return this.rpc; });
    vi.spyOn(codex.AppServerManager.prototype, "remoteUrl", "get").mockReturnValue("ws://127.0.0.1:65534");
    vi.spyOn(codex.AppServerManager.prototype, "ownership", "get").mockReturnValue({ port: 65534, launcherPid: null, listenerPid: null, startedAt: new Date(0).toISOString() });
    vi.spyOn(codex, "terminateStaleAppServer").mockResolvedValue(false);
    vi.spyOn(TuiProxyPool.prototype, "start").mockResolvedValue("ws://127.0.0.1:65534");
    const summary = vi.spyOn(codex.CodexRpcClient.prototype, "readThreadSummary").mockImplementation(async (id) => ({ thread: { id, cwd: root, path: savedFile, status: { type: "idle" } } }));
    const subscribe = vi.spyOn(codex.CodexRpcClient.prototype, "subscribeThread").mockResolvedValue();
    const response = await app.inject({ method: "POST", url: `/api/tabs/${tab.id}/terminal/reopen`, headers: { "x-codex-promptor-token": app.promptor.token } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.tab.session).toMatchObject({ state: "ready", threadId: a, lastDurableThreadId: a });
    if (mode === "pty-hooks") {
      expect(begin).toHaveBeenCalledWith(expect.objectContaining({ launch: { mode: "resume", sessionId: a } }));
      expect(nativeStart).toHaveBeenCalledOnce();
    } else {
      expect(remoteStart).toHaveBeenCalledWith(tab.id, root, expect.any(String), { mode: "resume", threadId: a }, expect.any(String));
      expect(summary.mock.calls.every(([id]) => id === a)).toBe(true);
      expect(subscribe).toHaveBeenCalledWith(a, root);
    }
    const bundle = await app.promptor.storage.readTab(tab.id);
    expect(bundle.answers.answers).toContainEqual(expect.objectContaining({ threadId: a, finalAnswer: "saved answer" }));
    expect(bundle.prompts.prompts).toContainEqual(expect.objectContaining({ text: "keep pending", status: "pending" }));
  });
});
