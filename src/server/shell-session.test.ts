import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: mocks.spawn }));

import { isoNow, type TabMeta } from "../shared/schemas.js";
import { createApp, tabsToRestore, type PromptorApp } from "./app.js";
import { buildShellCommand } from "./pty.js";

function fakePty() {
  const proc = {
    pid: 4321,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn(),
  };
  mocks.spawn.mockReturnValue(proc);
  return proc;
}

describe("terminal-only conversations", () => {
  let app: PromptorApp | null = null;
  let root = "";

  // One app for the whole file. Each test makes its own tab, so they stay
  // independent, and the suite does not pay for four more concurrent Fastify
  // instances -- enough extra load to time out the heavier integration files
  // running alongside it.
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-shell-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();
  });

  afterEach(() => { mocks.spawn.mockReset(); });

  afterAll(async () => {
    if (app) {
      await app.promptor.close();
      await app.close();
      app = null;
    }
    if (root) {
      // Storage finishes its atomic replaces just after close, and Windows
      // refuses to remove a directory while those land. Retry, and never let
      // a cleanup race be reported as a failing assertion.
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
      root = "";
    }
  });

  const post = (url: string, payload: unknown = {}) => app!.inject({
    method: "POST",
    url,
    headers: { "x-codex-promptor-token": app!.promptor.token },
    payload: payload as never,
  });

  it("opens a bare PowerShell in the requested directory with no agent identity", async () => {
    const proc = fakePty();
    const tab = await app!.promptor.storage.createTab("终端");

    const response = await post(`/api/tabs/${tab.id}/session`, { provider: "shell", workingDirectory: root });

    expect(response.statusCode).toBe(200);
    const session = response.json().data.bundle.tab.session;
    expect(session.provider).toBe("shell");
    expect(session.state).toBe("ready");
    expect(session.workingDirectory).toBe(path.resolve(root));
    // No agent, so no ids -- this is what keeps the queue and history switched off.
    expect(session.threadId).toBeNull();
    expect(session.sessionId).toBeNull();
    // startCommand writes the shell command after a short delay, so assert on
    // content rather than call count: whatever goes in is the Set-Location
    // prologue, never a bracketed-paste prompt or a submit Enter.
    const bracketedPaste = `${String.fromCharCode(27)}[200~`;
    for (const [written] of proc.write.mock.calls) {
      expect(String(written)).toContain("Set-Location");
      expect(String(written)).not.toContain(bracketedPaste);
    }
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: path.resolve(root) });
  });

  it("falls back to a default directory when the path is left empty", async () => {
    fakePty();
    const tab = await app!.promptor.storage.createTab("默认路径终端");

    const response = await post(`/api/tabs/${tab.id}/session`, { provider: "shell" });

    expect(response.statusCode).toBe(200);
    const directory = response.json().data.bundle.tab.session.workingDirectory;
    expect(directory).toBeTruthy();
    expect(directory).toBe(path.resolve(process.env.USERPROFILE ?? process.cwd()));
  });

  it("still demands a real directory from an agent conversation", async () => {
    const tab = await app!.promptor.storage.createTab("Codex");

    const response = await post(`/api/tabs/${tab.id}/session`, { provider: "codex" });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_WORKING_DIRECTORY");
  });

  it("refuses the queue and history routes instead of spinning up an App Server", async () => {
    fakePty();
    const tab = await app!.promptor.storage.createTab("终端");
    await post(`/api/tabs/${tab.id}/session`, { provider: "shell", workingDirectory: root });

    const sync = await post(`/api/tabs/${tab.id}/history/sync`);
    expect(sync.statusCode).toBe(400);
    expect(sync.json().error.code).toBe("SHELL_HAS_NO_HISTORY");

    for (const url of [`/api/tabs/${tab.id}/runner/start`, `/api/tabs/${tab.id}/prompts`]) {
      const refused = await post(url, { text: "ls" });
      expect(refused.statusCode).toBe(400);
    }
    // The RunnerManager binder would have created one via codex.get(tabId).
    expect(app!.promptor.codex.existing(tab.id)).toBeNull();
  });

  it("restores a terminal on relaunch even though it has no thread", () => {
    const base: TabMeta["session"] = {
      provider: "shell",
      launchMode: "new",
      state: "ready",
      reopenOnLaunch: true,
      workingDirectory: "D:\work",
      threadId: null,
      sessionId: null,
      createdAt: isoNow(),
      connectedAt: isoNow(),
      lastError: null,
      lastThreadSwitch: null,
    };
    const tab = (id: string, session: Partial<TabMeta["session"]>): TabMeta => ({
      id, name: id, groupId: null, order: 0, createdAt: isoNow(), updatedAt: isoNow(),
      session: { ...base, ...session }, layout: { leftWidthPercent: 42 },
    });

    expect(tabsToRestore([
      tab("shell-open", {}),
      tab("shell-no-directory", { workingDirectory: null }),
      tab("shell-closed", { state: "closed", reopenOnLaunch: false }),
      tab("agent-without-thread", { provider: "codex", threadId: null }),
    ])).toEqual(["shell-open"]);
  });

  it("builds a shell command that only lands in the directory", () => {
    const command = buildShellCommand("D:\work\project", "dark");
    expect(command).toContain("Set-Location -LiteralPath");
    expect(command).toContain("D:\work\project");
    expect(command).toContain("Clear-Host");
    // Nothing agent-shaped: no CLI invocation and no exit marker to parse.
    expect(command).not.toMatch(/codex|claude|agent/i);
    expect(command).not.toContain("PROMPTOR_EXIT");
  });
});
