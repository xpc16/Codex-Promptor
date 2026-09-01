import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import type { AppServerManager } from "./codex.js";
import { QUEUE_INTER_PROMPT_DELAY_MS, QueueRunner } from "./queue.js";
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

  it("arms itself after the queue has no pending prompts", async () => {
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
      // Running out of work is not the user stopping the queue: it goes back to
      // armed, so the next prompt added runs without another start click.
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.desiredState === "armed");
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

      // This test is about thread filtering. Keep the queue rolling past the
      // deliberately injected provider failure so it can reach its empty arm.
      await runner.configure("continue");
      await runner.start();
      await waitUntil(async () => {
        const current = await storage.readTab(tab.id);
        return calls.length === 1 && current.runtime.runner.desiredState === "armed";
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
      const calls: Array<{ turnId: string; text: string; cwd: string; startedAt: number }> = [];
      const codex = {
        rpc: {
          waitForThreadIdle: async () => undefined,
          startTurn: async (_threadId: string, text: string, _clientId: string, cwd: string) => {
            const turnId = `turn-${calls.length + 1}`;
            calls.push({ turnId, text, cwd, startedAt: Date.now() });
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
      const testDelayMs = 40;
      const runner = new QueueRunner(tab.id, storage, codex, 5_000, testDelayMs);

      await runner.start();
      await firstStarted;
      await waitUntil(async () => (await storage.readTab(tab.id)).answers.answers.length === 1);
      const activeAnswer = (await storage.readTab(tab.id)).answers.answers[0];
      expect(activeAnswer).toMatchObject({
        prompt: "第一条",
        status: "running",
        finalAnswer: "",
        completedAt: null,
      });
      expect(activeAnswer.startedAt).not.toBeNull();
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
      const completedAnswers = (await storage.readTab(tab.id)).answers.answers;
      expect(completedAnswers).toHaveLength(2);
      expect(completedAnswers[0]).toMatchObject({ id: activeAnswer.id, status: "completed", finalAnswer: "第一条完成" });
      expect(completedAnswers[0].completedAt).not.toBeNull();
      expect(QUEUE_INTER_PROMPT_DELAY_MS).toBe(5_000);
      expect(calls[1].startedAt - Date.parse(completedAnswers[0].completedAt!)).toBeGreaterThanOrEqual(testDelayMs);
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts the current prompt, records it, and pauses the queue", async () => {
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
            return {
              turn: { id: "turn-freeze", status: "interrupted" },
              items: [
                { type: "userMessage", text: "执行中的 prompt" },
                { type: "agentMessage", phase: "commentary", text: "尚未完成的过程更新" },
              ],
            };
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
      await expect(runner.interruptCurrent()).resolves.toBe(true);

      expect(interruptions).toEqual([{ threadId: "thread-freeze", turnId: "turn-freeze" }]);
      const frozen = await storage.readTab(tab.id);
      expect(frozen.runtime.runner).toMatchObject({ desiredState: "paused", state: "paused", activePromptId: null, activeTurnId: null, lastError: null });
      expect(frozen.prompts.prompts[0]).toMatchObject({ status: "interrupted", error: { code: "TURN_INTERRUPTED" } });
      expect(frozen.prompts.prompts[0].attempts[0]).toMatchObject({ status: "interrupted", error: { code: "TURN_INTERRUPTED" } });
      expect(frozen.answers.answers).toHaveLength(1);
      expect(frozen.answers.answers[0]).toMatchObject({
        prompt: "执行中的 prompt",
        status: "interrupted",
        finalAnswer: "",
        error: { code: "TURN_INTERRUPTED" },
      });
      expect(frozen.answers.answers[0].startedAt).not.toBeNull();
      expect(frozen.answers.answers[0].completedAt).not.toBeNull();
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detaches a timed-out interrupted turn so later prompts can run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-freeze-timeout-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("中断超时兜底");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-timeout", sessionId: "thread-timeout", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.prompts.prompts.push(newPrompt("等待中断确认", "queue"), newPrompt("中断后的下一条", "queue"));
      await storage.writePrompts(tab.id, bundle.prompts);

      let releaseTurn!: () => void;
      const turnGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
      const started: string[] = [];
      const codex = {
        rpc: {
          waitForThreadIdle: async () => undefined,
          startTurn: async (_threadId: string, text: string) => {
            started.push(text);
            return { turnId: started.length === 1 ? "turn-timeout" : "turn-after-timeout" };
          },
          waitForTurn: async (turnId: string) => {
            if (turnId === "turn-timeout") {
              await turnGate;
              return { turn: { id: turnId, status: "interrupted" }, items: [{ type: "userMessage", text: "等待中断确认" }] };
            }
            return {
              turn: { id: turnId, status: "completed" },
              items: [
                { type: "userMessage", text: "中断后的下一条" },
                { type: "agentMessage", phase: "final_answer", text: "下一条已完成" },
              ],
            };
          },
          interruptTurn: async () => undefined,
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex, 5);

      await runner.start();
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.activeTurnId === "turn-timeout");
      await runner.freeze();

      const frozen = await storage.readTab(tab.id);
      expect(frozen.runtime.runner).toMatchObject({ desiredState: "paused", state: "paused", activePromptId: null, activeTurnId: null });
      expect(frozen.prompts.prompts[0]).toMatchObject({ status: "interrupted", error: { code: "TURN_INTERRUPTED" } });
      expect(frozen.answers.answers[0]).toMatchObject({ status: "interrupted", finalAnswer: "", error: { code: "TURN_INTERRUPTED" } });
      expect(frozen.answers.answers[0].completedAt).not.toBeNull();

      await runner.start();
      await waitUntil(async () => {
        const current = await storage.readTab(tab.id);
        return current.runtime.runner.state === "paused" && current.prompts.prompts[1]?.status === "completed";
      });
      expect(started).toEqual(["等待中断确认", "中断后的下一条"]);

      releaseTurn();
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.state === "paused");
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts a turn whose id arrives after the Interrupt button was pressed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-late-turn-id-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("启动期间中断");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-late-id", sessionId: "thread-late-id", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.prompts.prompts.push(newPrompt("启动尚未返回", "queue"));
      await storage.writePrompts(tab.id, bundle.prompts);

      let releaseStart!: () => void;
      const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
      const interruptions: string[] = [];
      const codex = {
        rpc: {
          waitForThreadIdle: async () => undefined,
          startTurn: async () => { await startGate; return { turnId: "turn-late-id" }; },
          interruptTurn: async (_threadId: string, turnId: string) => { interruptions.push(turnId); },
          waitForTurn: async () => { throw new Error("detached turn must not be awaited"); },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex, 5);

      await runner.start();
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.activePromptId !== null);
      await expect(runner.interruptCurrent()).resolves.toBe(false);
      releaseStart();

      await waitUntil(async () => {
        const current = await storage.readTab(tab.id);
        return current.prompts.prompts[0]?.status === "interrupted" && current.runtime.runner.activePromptId === null;
      });
      const interrupted = await storage.readTab(tab.id);
      expect(interruptions).toEqual(["turn-late-id"]);
      expect(interrupted.runtime.runner).toMatchObject({ desiredState: "paused", state: "paused", activePromptId: null, activeTurnId: null });
      expect(interrupted.answers.answers[0]).toMatchObject({ status: "interrupted", codexTurnId: "turn-late-id" });
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("interrupts an unconfirmed PTY submission before a provider turn id exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-queue-unconfirmed-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("unconfirmed submission");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-unconfirmed", sessionId: "thread-unconfirmed", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.prompts.prompts.push(newPrompt("waiting for transcript", "queue"));
      await storage.writePrompts(tab.id, bundle.prompts);

      let rejectStart!: (error: Error) => void;
      let pendingInterrupts = 0;
      const binding = {
        rpc: {
          activeTurnIds: () => [],
          waitForThreadIdle: async () => undefined,
          startTurn: async () => new Promise<{ turnId: string }>((_resolve, reject) => { rejectStart = reject; }),
          interruptPendingSubmission: async () => {
            pendingInterrupts += 1;
            rejectStart(new Error("PROMPT_SUBMISSION_INTERRUPTED"));
            return true;
          },
        },
      } as any;
      const runner = new QueueRunner(tab.id, storage, binding, 200);
      await runner.start();
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.activePromptId !== null);

      await expect(runner.interruptCurrent()).resolves.toBe(true);
      const interrupted = await storage.readTab(tab.id);
      expect(pendingInterrupts).toBe(1);
      expect(interrupted.runtime.runner).toMatchObject({ desiredState: "paused", state: "paused", activePromptId: null, activeTurnId: null });
      expect(interrupted.prompts.prompts[0]).toMatchObject({ status: "interrupted", error: { code: "TURN_INTERRUPTED" } });
      expect(interrupted.answers.answers[0]).toMatchObject({
        status: "interrupted",
        error: { code: "TURN_INTERRUPTED" },
        codexTurnId: expect.stringContaining("submission-interrupted:"),
      });
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("insert now", () => {
  it("steers a pending prompt into the active turn without interrupting it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-steer-active-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("运行中插入");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-steer", sessionId: "thread-steer", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      const pending = newPrompt("追加要求", "queue");
      bundle.prompts.prompts.push(pending);
      await storage.writePrompts(tab.id, bundle.prompts);

      const calls: any[][] = [];
      const codex = {
        rpc: {
          activeTurnIds: () => ["turn-active"],
          steerTurn: async (...args: any[]) => { calls.push(args); return {}; },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      const result = await runner.insertNow(pending.id, "  修改后的追加要求  ");
      const updated = (await storage.readTab(tab.id)).prompts.prompts[0];

      expect(result).toEqual({ mode: "steered", turnId: "turn-active" });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.slice(0, 3)).toEqual(["thread-steer", "turn-active", "修改后的追加要求"]);
      expect(updated).toMatchObject({ text: "修改后的追加要求", status: "running", threadId: "thread-steer", codexTurnId: "turn-active" });
      expect(updated.attempts[0]).toMatchObject({ status: "running", delivery: "steer", codexTurnId: "turn-active" });
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["paused", "paused"],
    ["armed", "armed"],
  ] as const)("runs only the selected prompt and never disturbs the idle queue (%s)", async (before, after) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-insert-idle-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("空闲时立即运行");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-idle-now", sessionId: "thread-idle-now", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      // Running one prompt on request says nothing about whether the queue
      // rolls, so the setting must read the same before, during and after.
      bundle.runtime.runner.desiredState = before;
      await storage.writeRuntime(tab.id, bundle.runtime);
      const earlier = newPrompt("原先排队", "queue");
      const selected = newPrompt("只运行这一条", "queue");
      bundle.prompts.prompts.push(earlier, selected);
      await storage.writePrompts(tab.id, bundle.prompts);

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[] = [];
      const codex = {
        rpc: {
          activeTurnIds: () => [],
          waitForThreadIdle: async () => undefined,
          startTurn: async (_threadId: string, text: string) => { calls.push(text); return { turnId: "turn-one-shot" }; },
          waitForTurn: async () => {
            await gate;
            return {
              turn: { id: "turn-one-shot", status: "completed" },
              items: [
                { type: "userMessage", text: "只运行这一条" },
                { type: "agentMessage", phase: "final_answer", text: "单条完成" },
              ],
            };
          },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex);

      expect(await runner.insertNow(selected.id, "  修改后只运行这一条  ")).toEqual({ mode: "started", turnId: null });
      await waitUntil(async () => calls.length === 1);
      expect(calls).toEqual(["修改后只运行这一条"]);
      // Mid-turn, with the prompt dispatched and the answer not back yet: the
      // queue still reads as the user set it, never as rolling.
      const midTurn = await storage.readTab(tab.id);
      expect(midTurn.runtime.runner.desiredState).toBe(before);
      expect(midTurn.runtime.runner.activePromptId).toBe(selected.id);
      release();
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.state === "paused");

      const finished = await storage.readTab(tab.id);
      expect(finished.runtime.runner.desiredState).toBe(after);
      expect(finished.prompts.prompts.find((item) => item.id === selected.id)).toMatchObject({ text: "修改后只运行这一条", status: "completed" });
      expect(finished.prompts.prompts.find((item) => item.id === earlier.id)?.status).toBe("pending");
      expect(finished.answers.answers).toHaveLength(1);
      await runner.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("starting the queue during a one-shot", () => {
  it("takes over the run instead of stopping after the requested prompt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-insert-then-start-"));
    const storage = new StorageService(root);
    try {
      await storage.ensure();
      const tab = await storage.createTab("先插入再开始");
      await storage.updateTab(tab.id, (current) => ({
        ...current,
        updatedAt: isoNow(),
        session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-takeover", sessionId: "thread-takeover", connectedAt: isoNow() },
      }));
      const bundle = await storage.readTab(tab.id);
      bundle.runtime.runner.desiredState = "armed";
      await storage.writeRuntime(tab.id, bundle.runtime);
      const earlier = newPrompt("原先排队", "queue");
      const selected = newPrompt("只运行这一条", "queue");
      bundle.prompts.prompts.push(earlier, selected);
      await storage.writePrompts(tab.id, bundle.prompts);

      const calls: string[] = [];
      const gates: Array<() => void> = [];
      const sent = new Map<string, string>();
      let turns = 0;
      const codex = {
        rpc: {
          activeTurnIds: () => [],
          waitForThreadIdle: async () => undefined,
          startTurn: async (_threadId: string, text: string) => {
            calls.push(text);
            const turnId = `turn-${++turns}`;
            sent.set(turnId, text);
            return { turnId };
          },
          waitForTurn: async (turnId: string) => {
            await new Promise<void>((resolve) => gates.push(resolve));
            return {
              turn: { id: turnId, status: "completed" },
              items: [
                { type: "userMessage", text: sent.get(turnId) },
                { type: "agentMessage", phase: "final_answer", text: `已完成 ${turnId}` },
              ],
            };
          },
        },
      } as unknown as AppServerManager;
      const runner = new QueueRunner(tab.id, storage, codex, 5_000, 5);

      await runner.insertNow(selected.id);
      await waitUntil(async () => calls.length === 1 && gates.length === 1);
      expect((await storage.readTab(tab.id)).runtime.runner.desiredState).toBe("armed");

      // Pressing start mid-turn is a decision to keep going, and it has to
      // outrank the one-shot's standing instruction to stop after this prompt.
      await runner.start();
      const afterStart = await storage.readTab(tab.id);
      expect(afterStart.runtime.runner.desiredState).toBe("running");
      expect(afterStart.runtime.runner.state).toBe("running");
      expect(afterStart.runtime.runner.activePromptId).toBe(selected.id);
      gates.shift()!();

      await waitUntil(async () => calls.length === 2 && gates.length === 1);
      expect(calls).toEqual(["只运行这一条", "原先排队"]);
      gates.shift()!();
      // Rolling to the end of the queue arms it, as a finished run always does.
      await waitUntil(async () => (await storage.readTab(tab.id)).runtime.runner.desiredState === "armed");
      expect((await storage.readTab(tab.id)).prompts.prompts.map((prompt) => prompt.status)).toEqual(["completed", "completed"]);
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
