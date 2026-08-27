import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { StorageService } from "./storage.js";
import { syncTerminalThreadSelection } from "./terminal-thread-sync.js";

describe("terminal thread synchronization", () => {
  it("rebinds the tab, subscribes the controller and imports completed history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-thread-switch-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("switch");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", threadId: "thread-a", sessionId: "thread-a", workingDirectory: root, connectedAt: isoNow() },
      }));
      const history = {
        id: "thread-b",
        sessionId: "session-root",
        cwd: root,
        turns: [{
          id: "turn-b",
          status: "completed",
          items: [
            { type: "userMessage", text: "historic prompt" },
            { type: "agentMessage", phase: "final_answer", text: "historic final" },
          ],
        }],
      };
      // The summary carries no turns and this thread has no rollout on disk,
      // so history has to come from the projection -- the one case the file
      // cannot answer.
      const rpc = {
        resumeThread: vi.fn().mockResolvedValue({ thread: history }),
        readThread: vi.fn().mockResolvedValue({ thread: history }),
        readThreadSummary: vi.fn().mockResolvedValue({ thread: { id: "thread-b", sessionId: "session-root", cwd: root } }),
      };
      const runner = { freeze: vi.fn().mockResolvedValue(undefined), start: vi.fn().mockResolvedValue(undefined) };

      const result = await syncTerminalThreadSelection({
        storage,
        tabId: tab.id,
        rpc,
        runner,
        selection: { method: "thread/resume", requestedThreadId: "thread-b", requestedCwd: root, thread: { id: "thread-b", sessionId: "session-root", cwd: root } },
      });

      expect(result).toMatchObject({ previousThreadId: "thread-a", threadId: "thread-b", sessionId: "session-root" });
      expect(rpc.resumeThread).toHaveBeenCalledWith("thread-b", root);
      expect(rpc.readThreadSummary).toHaveBeenCalledWith("thread-b");
      expect(rpc.readThread).toHaveBeenCalledWith("thread-b");
      const bundle = await storage.readTab(tab.id);
      expect(bundle.tab.session.threadId).toBe("thread-b");
      expect(bundle.tab.session.lastThreadSwitch).toMatchObject({ fromThreadId: "thread-a", toThreadId: "thread-b", method: "thread/resume" });
      expect(bundle.prompts.prompts.map((prompt) => prompt.text)).toContain("historic prompt");
      expect(bundle.answers.answers).toContainEqual(expect.objectContaining({ threadId: "thread-b", finalAnswer: "historic final" }));
      expect(runner.freeze).toHaveBeenCalledOnce();
      expect(runner.start).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does nothing when the TUI confirms the already-bound thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-thread-same-"));
    try {
      const storage = new StorageService(root);
      await storage.ensure();
      const tab = await storage.createTab("same");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        session: { ...current.session, state: "ready", threadId: "thread-a", sessionId: "thread-a", workingDirectory: root },
      }));
      const rpc = { resumeThread: vi.fn(), readThread: vi.fn(), readThreadSummary: vi.fn() };
      const runner = { freeze: vi.fn(), start: vi.fn() };
      await expect(syncTerminalThreadSelection({
        storage,
        tabId: tab.id,
        rpc,
        runner,
        selection: { method: "thread/resume", requestedThreadId: "thread-a", requestedCwd: null, thread: { id: "thread-a" } },
      })).resolves.toBeNull();
      expect(runner.freeze).not.toHaveBeenCalled();
      expect(rpc.readThread).not.toHaveBeenCalled();
      expect(rpc.readThreadSummary).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
