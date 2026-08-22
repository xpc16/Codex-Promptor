import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { recoverTerminalRuntime } from "./app.js";
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
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-1", sessionId: "thread-1", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.runner.desiredState = "running";
      bundle.runtime.runner.state = "running";
      bundle.runtime.runner.activeTurnId = "turn-1";
      await storage.writeRuntime(tab.id, bundle.runtime);

      expect(await recoverTerminalRuntime(storage)).toBe(1);
      const recovered = await storage.readTab(tab.id);
      expect(recovered.tab.session.state).toBe("closed");
      expect(recovered.runtime.runner).toMatchObject({ desiredState: "paused", state: "paused", activeTurnId: null, activePromptId: null });
      expect(await recoverTerminalRuntime(storage)).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
