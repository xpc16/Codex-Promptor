import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import type { AppServerManager } from "./codex.js";
import { QueueRunner } from "./queue.js";
import { StorageService } from "./storage.js";

class HookedStorage extends StorageService {
  beforeNextTabLock: (() => Promise<void>) | null = null;

  override async withTabLock<T>(tabId: string, task: () => Promise<T>): Promise<T> {
    const hook = this.beforeNextTabLock;
    this.beforeNextTabLock = null;
    if (hook) await hook();
    return super.withTabLock(tabId, task);
  }
}

describe("queue pause boundary", () => {
  it("does not dispatch when pause is persisted immediately before the locked dispatch step", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-"));
    const storage = new HookedStorage(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("暂停竞态");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-1", sessionId: "thread-1", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.prompts.prompts.push(newPrompt("不应发送", "queue"));
      await storage.writePrompts(tab.id, bundle.prompts);

      let releaseIdle!: () => void;
      const idleGate = new Promise<void>((resolve) => { releaseIdle = resolve; });
      let reportIdleEntered!: () => void;
      const idleEntered = new Promise<void>((resolve) => { reportIdleEntered = resolve; });
      let startTurnCalls = 0;
      const codex = {
        rpc: {
          waitForThreadIdle: async () => { reportIdleEntered(); await idleGate; },
          startTurn: async () => { startTurnCalls += 1; return { turnId: "turn-1" }; },
          waitForTurn: async () => ({ turn: { id: "turn-1", status: "completed" }, items: [] }),
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      await runner.start();
      await idleEntered;
      storage.beforeNextTabLock = async () => {
        const current = await storage.readTab(tab.id);
        current.runtime.runner.desiredState = "paused";
        current.runtime.runner.state = "paused";
        await storage.writeRuntime(tab.id, current.runtime);
      };
      releaseIdle();

      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.state === "paused");
      expect(startTurnCalls).toBe(0);
      expect((await storage.readTab(tab.id)).prompts.prompts[0].status).toBe("pending");
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("automatically pauses after the queue has no pending prompts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-empty-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("自动暂停");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-2", sessionId: "thread-2", connectedAt: isoNow() },
      }));
      let idleChecks = 0;
      const codex = { rpc: { waitForThreadIdle: async () => { idleChecks += 1; } } } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      await runner.start();
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.desiredState === "paused");
      const runtime = (await storage.readTab(tab.id)).runtime.runner;
      expect(runtime.state).toBe("paused");
      expect(idleChecks).toBe(1);
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not dispatch pending prompts owned by another thread", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-thread-scope-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("thread scoped queue");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "current-thread", sessionId: "current-thread", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      const otherThreadPrompt = newPrompt("belongs elsewhere", "queue");
      otherThreadPrompt.threadId = "other-thread";
      const unboundPrompt = newPrompt("run here", "queue");
      bundle.prompts.prompts.push(otherThreadPrompt, unboundPrompt);
      await storage.writePrompts(tab.id, bundle.prompts);

      const calls: string[] = [];
      const codex = {
        rpc: {
          waitForThreadIdle: async () => undefined,
          startTurn: async (_threadId: string, text: string) => {
            calls.push(text);
            throw new Error("expected test stop");
          },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      await runner.start();
      await waitUntil(async () => {
        const current = await storage.readTab(tab.id);
        return calls.length === 1 && current.runtime.runner.desiredState === "paused";
      });
      const result = await storage.readTab(tab.id);
      expect(calls).toEqual(["run here"]);
      expect(result.prompts.prompts.find((prompt) => prompt.id === otherThreadPrompt.id)?.status).toBe("pending");
      expect(result.prompts.prompts.find((prompt) => prompt.id === unboundPrompt.id)?.threadId).toBe("current-thread");
      expect(result.prompts.prompts.find((prompt) => prompt.id === unboundPrompt.id)?.status).toBe("failed");
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("re-reads prompts added during the final active turn and keeps the selected cwd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-dynamic-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("动态队列");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-dynamic", sessionId: "thread-dynamic", connectedAt: isoNow() },
      }));
      const initial = await storage.readTab(tab.id);
      initial.prompts.prompts.push(newPrompt("第一条", "queue"));
      await storage.writePrompts(tab.id, initial.prompts);

      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let reportFirstStarted!: () => void;
      const firstStarted = new Promise<void>((resolve) => { reportFirstStarted = resolve; });
      const calls: Array<{ turnId: string; text: string; cwd: string }> = [];
      const codex = {
        rpc: {
          waitForThreadIdle: async () => undefined,
          startTurn: async (_threadId: string, text: string, _clientId: string, cwd: string) => {
            const turnId = `turn-${calls.length + 1}`;
            calls.push({ turnId, text, cwd });
            if (turnId === "turn-1") reportFirstStarted();
            return { turnId };
          },
          waitForTurn: async (turnId: string) => {
            if (turnId === "turn-1") await firstGate;
            const text = calls.find((call) => call.turnId === turnId)?.text ?? "";
            return {
              turn: { id: turnId, status: "completed" },
              items: [
                { type: "userMessage", text },
                { type: "agentMessage", phase: "final_answer", text: `${text}完成` },
              ],
            };
          },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      await runner.start();
      await firstStarted;
      await storage.withTabLock(tab.id, async () => {
        const during = await storage.readTab(tab.id);
        during.prompts.prompts.push(newPrompt("最后执行期间追加", "queue"));
        await storage.writePrompts(tab.id, during.prompts);
      });
      await runner.start();
      releaseFirst();

      await waitUntil(async () => {
        const bundle = await storage.readTab(tab.id);
        return bundle.runtime.runner.state === "paused" && bundle.prompts.prompts.every((prompt) => prompt.status === "completed");
      });
      expect(calls.map((call) => call.text)).toEqual(["第一条", "最后执行期间追加"]);
      expect(calls.every((call) => call.cwd === root)).toBe(true);
      expect((await storage.readTab(tab.id)).answers.answers).toHaveLength(2);
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freezes the queue and interrupts its active turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-freeze-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("关闭对话");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-freeze", sessionId: "thread-freeze", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.prompts.prompts.push(newPrompt("执行中的 prompt", "queue"));
      await storage.writePrompts(tab.id, bundle.prompts);

      let reportStarted!: () => void;
      const started = new Promise<void>((resolve) => { reportStarted = resolve; });
      let finishTurn!: () => void;
      const turnFinished = new Promise<void>((resolve) => { finishTurn = resolve; });
      const interruptions: Array<{ threadId: string; turnId: string }> = [];
      const codex = {
        rpc: {
          waitForThreadIdle: async () => undefined,
          startTurn: async () => { reportStarted(); return { turnId: "turn-freeze" }; },
          waitForTurn: async () => {
            await turnFinished;
            return { turn: { id: "turn-freeze", status: "interrupted" }, items: [] };
          },
          interruptTurn: async (threadId: string, turnId: string) => {
            interruptions.push({ threadId, turnId });
            finishTurn();
          },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      await runner.start();
      await started;
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.activeTurnId === "turn-freeze");
      await runner.freeze();

      expect(interruptions).toEqual([{ threadId: "thread-freeze", turnId: "turn-freeze" }]);
      expect((await storage.readTab(tab.id)).runtime.runner.desiredState).toBe("paused");
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
