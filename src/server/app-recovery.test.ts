import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { isTrustedBrowserOrigin, isTrustedBrowserRequest, recordOpenSessionsForNextLaunch, recoverTerminalRuntime, tabsToRestore } from "./app.js";
import { StorageService } from "./storage.js";

describe("runtime recovery", () => {
  it("clears terminal states that cannot survive a service restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("恢复测试");
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.terminal.state = "running";
      bundle.runtime.terminal.lastStartedAt = new Date().toISOString();
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.runtime.terminal.state).toBe("stopped");
      expect(recovered.runtime.terminal.lastStartedAt).not.toBeNull();
      expect(await recoverTerminalRuntime(storage)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("closes sessions and pauses queues whose processes cannot survive restart", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-session-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("会话恢复测试");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", reopenOnLaunch: true, workingDirectory: root, threadId: "thread-1", sessionId: "thread-1", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.runner.desiredState = "running";
      bundle.runtime.runner.state = "running";
      bundle.runtime.runner.activeTurnId = "turn-1";
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.tab.session.state).toBe("closed");
      expect(recovered.tab.session.reopenOnLaunch).toBe(true);
      expect(recovered.runtime.runner).toMatchObject({ desiredState: "paused", state: "paused", activeTurnId: null, activePromptId: null });
      expect(await recoverTerminalRuntime(storage)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears a stale runner even when the conversation was already closed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-closed-runner-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("已关闭但仍显示运行");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", workingDirectory: root, threadId: "thread-stale", sessionId: "thread-stale" },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.runner.state = "pausing";
      bundle.runtime.runner.activePromptId = "prompt-stale";
      bundle.runtime.runner.activeTurnId = "turn-stale";
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      expect((await storage.readTab(tab.id)).runtime.runner).toMatchObject({
        desiredState: "paused",
        state: "paused",
        activePromptId: null,
        activeTurnId: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears persisted App Server ownership after restart recovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-owner-recovery-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("进程归属恢复测试");
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.terminal.appServer = {
        launcherPid: null,
        listenerPid: null,
        port: 65_534,
        startedAt: new Date(0).toISOString(),
      };
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      expect((await storage.readTab(tab.id)).runtime.terminal.appServer).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("launch restoration state", () => {
  it("restores marked tabs, supports legacy ready tabs, and records the final open set", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-open-state-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const legacyReady = await storage.createTab("旧版开启状态");
      const markedClosed = await storage.createTab("等待自动恢复");
      const closed = await storage.createTab("手动关闭");
      await storage.updateTab(legacyReady.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-ready", sessionId: "thread-ready" },
      }));
      await storage.updateTab(markedClosed.id, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", reopenOnLaunch: true, workingDirectory: root, threadId: "thread-marked", sessionId: "thread-marked" },
      }));
      await storage.updateTab(closed.id, (current) => ({
        ...current,
        session: { ...current.session, state: "closed", workingDirectory: root, threadId: "thread-closed", sessionId: "thread-closed" },
      }));

      expect(new Set(tabsToRestore(await storage.listTabMeta()))).toEqual(new Set([legacyReady.id, markedClosed.id]));
      expect(await recordOpenSessionsForNextLaunch(storage)).toEqual([legacyReady.id]);
      expect((await storage.getTabMeta(legacyReady.id)).session.reopenOnLaunch).toBe(true);
      expect((await storage.getTabMeta(markedClosed.id)).session.reopenOnLaunch).toBe(false);
      expect((await storage.getTabMeta(closed.id)).session.reopenOnLaunch).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("local browser origin", () => {
  it("accepts the fixed loopback URL and rejects cross-site or rebound hosts", () => {
    expect(isTrustedBrowserOrigin("http://127.0.0.1:4317", "127.0.0.1:4317")).toBe(true);
    expect(isTrustedBrowserOrigin("http://localhost:4317", "localhost:4317")).toBe(true);
    expect(isTrustedBrowserOrigin("https://example.com", "127.0.0.1:4317")).toBe(false);
    expect(isTrustedBrowserOrigin("http://example.com:4317", "example.com:4317")).toBe(false);
    expect(isTrustedBrowserOrigin(undefined, "127.0.0.1:4317")).toBe(false);
    expect(isTrustedBrowserRequest({ referer: "http://127.0.0.1:4317/", host: "127.0.0.1:4317" })).toBe(true);
    expect(isTrustedBrowserRequest({ referer: "http://example.com/", host: "127.0.0.1:4317" })).toBe(false);
  });
});
