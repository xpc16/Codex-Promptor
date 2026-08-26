import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isoNow, newAttempt, type AnswerRecord, type PromptRecord, type RuntimeFile } from "../shared/schemas.js";
import { recordTurn, recordTurnStarted, turnStatus } from "./history.js";
import { StorageService } from "./storage.js";

export type RunnerEvent = { tabId: string; type: "runtime" | "answer" | "error"; data?: unknown };
export type InsertNowResult = { mode: "steered" | "started"; turnId: string | null };
/** The queue only depends on a small normalized turn protocol. Codex App
 * Server plus the Claude Code and Cursor CLI PTY/hooks adapters implement it. */
export type QueueRpc = {
  activeTurnIds(threadId: string): string[];
  waitForThreadIdle(threadId: string, timeoutMs?: number): Promise<void>;
  startTurn(threadId: string, text: string, clientUserMessageId: string, cwd: string): Promise<{ turnId: string }>;
  steerTurn(threadId: string, turnId: string, text: string, clientUserMessageId: string): Promise<unknown>;
  interruptTurn(threadId: string, turnId: string): Promise<unknown>;
  waitForTurn(turnId: string): Promise<{ turn: any; items: any[] }>;
};
export type QueueBinding = { rpc: QueueRpc };
type QueueResolver = QueueBinding | (() => QueueBinding);

export class QueueRunner extends EventEmitter {
  private loopPromise: Promise<void> | null = null;
  private loopGeneration = 0;
  private stopping = false;
  private pauseAfterPromptId: string | null = null;

  constructor(
    readonly tabId: string,
    private readonly storage: StorageService,
    private readonly queueBinding: QueueResolver,
    private readonly freezeTimeoutMs = 5_000,
  ) {
    super();
    // EventEmitter treats an unobserved `error` event as an exception. QueueRunner
    // can also be used directly in tests and maintenance scripts, so keep the
    // event non-fatal until RunnerManager attaches its forwarding listener.
    this.on("error", () => undefined);
  }

  async start(): Promise<void> {
    this.pauseAfterPromptId = null;
    await this.activate();
  }

  private async activate(): Promise<void> {
    if (this.loopPromise) {
      const current = await this.storage.readTab(this.tabId);
      if (current.runtime.runner.desiredState === "running") return;
    }
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: { ...runtime.runner, desiredState: "running", state: "starting", lastError: null, lastTransitionAt: isoNow() },
    }));
    this.stopping = false;
    this.launchLoop();
  }

  private launchLoop(): void {
    if (this.loopPromise || this.stopping) return;
    const generation = ++this.loopGeneration;
    let loop!: Promise<void>;
    loop = this.runLoop(generation).finally(async () => {
      // An interrupted loop may have been deliberately detached after its
      // provider failed to acknowledge the interruption. Never let that old
      // promise clear or restart a newer queue loop when it eventually settles.
      if (this.loopPromise !== loop) return;
      this.loopPromise = null;
      if (this.stopping) return;
      try {
        const current = await this.storage.readTab(this.tabId);
        if (current.runtime.runner.desiredState === "running") this.launchLoop();
      } catch { /* a deleted tab must not restart its runner */ }
    });
    this.loopPromise = loop;
  }

  async pause(): Promise<void> {
    this.pauseAfterPromptId = null;
    await this.pauseRunner();
  }

  private async pauseRunner(): Promise<void> {
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: {
        ...runtime.runner,
        desiredState: "paused",
        state: runtime.runner.activeTurnId ? "pausing" : "paused",
        lastTransitionAt: isoNow(),
      },
    }));
  }

  async configure(onFailure: "pause" | "continue"): Promise<RuntimeFile> {
    return this.updateRuntime((runtime) => ({ ...runtime, queueConfig: { onFailure } }));
  }

  async insertNow(promptId: string): Promise<InsertNowResult> {
    const initial = await this.storage.readTab(this.tabId);
    const threadId = initial.tab.session.threadId;
    if (initial.tab.session.state !== "ready" || !threadId || !initial.tab.session.workingDirectory) throw new Error("SESSION_NOT_READY");
    const prompt = initial.prompts.prompts.find((item) => item.id === promptId);
    if (!prompt) throw new Error("PROMPT_NOT_FOUND");
    if (prompt.status !== "pending" || (prompt.threadId && prompt.threadId !== threadId)) throw new Error("PROMPT_NOT_PENDING");

    const activeTurnIds = this.agent().rpc.activeTurnIds(threadId);
    const activeTurnId = initial.runtime.runner.activeTurnId && activeTurnIds.includes(initial.runtime.runner.activeTurnId)
      ? initial.runtime.runner.activeTurnId
      : activeTurnIds.at(-1) ?? null;
    if (activeTurnId) {
      try {
        await this.steerPendingPrompt(promptId, threadId, activeTurnId);
        return { mode: "steered", turnId: activeTurnId };
      } catch (error) {
        // The active turn can finish between discovery and turn/steer. In that
        // narrow race, honor "run now" by starting the prompt normally.
        if (this.agent().rpc.activeTurnIds(threadId).length) throw error;
      }
    }
    return this.startPendingPromptNow(promptId, threadId);
  }

  async retry(promptId: string): Promise<void> {
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
      if (!prompt) throw new Error("PROMPT_NOT_FOUND");
      if (!["failed", "interrupted"].includes(prompt.status)) throw new Error("PROMPT_NOT_RETRYABLE");
      prompt.status = "pending";
      prompt.error = null;
      prompt.completedAt = null;
      prompt.updatedAt = isoNow();
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
    });
  }

  async skip(promptId: string): Promise<void> {
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
      if (!prompt) throw new Error("PROMPT_NOT_FOUND");
      if (!["failed", "interrupted"].includes(prompt.status)) throw new Error("PROMPT_NOT_SKIPPABLE");
      prompt.status = "skipped";
      prompt.updatedAt = isoNow();
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.freeze();
  }

  async freeze(): Promise<void> {
    await this.interruptCurrent();
  }

  async interruptCurrent(): Promise<boolean> {
    const activeLoop = this.loopPromise;
    await this.pause();
    let bundle = await this.storage.readTab(this.tabId);
    const threadId = bundle.tab.session.threadId;
    let turnId = bundle.runtime.runner.activeTurnId;
    // turn/start can be in flight after the prompt was reserved but before its
    // turn id is persisted. Keep Interrupt effective in that short window by
    // waiting for the id instead of abandoning a request that may already have
    // reached the provider.
    if (threadId && bundle.runtime.runner.activePromptId && !turnId && activeLoop) {
      const deadline = Date.now() + this.freezeTimeoutMs;
      while (Date.now() < deadline && !turnId) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
        bundle = await this.storage.readTab(this.tabId);
        if (!bundle.runtime.runner.activePromptId) break;
        turnId = bundle.runtime.runner.activeTurnId;
      }
    }
    if (!threadId || !turnId) {
      this.abandonLoop(activeLoop);
      return false;
    }
    try { await this.agent().rpc.interruptTurn(threadId, turnId); } catch { /* the turn may have completed at the pause boundary */ }
    let loopSettled = !activeLoop;
    if (activeLoop) {
      await Promise.race([
        activeLoop.then(() => { loopSettled = true; }, () => { loopSettled = true; }),
        new Promise<void>((resolve) => setTimeout(resolve, this.freezeTimeoutMs)),
      ]);
    }
    await this.finalizeInterruptedTurn(threadId, turnId);
    if (!loopSettled) this.abandonLoop(activeLoop);
    return true;
  }

  private abandonLoop(loop: Promise<void> | null): void {
    if (!loop || this.loopPromise !== loop) return;
    this.loopGeneration += 1;
    this.loopPromise = null;
  }

  private async runLoop(generation: number): Promise<void> {
    try {
      while (!this.stopping && generation === this.loopGeneration) {
        const bundle = await this.storage.readTab(this.tabId);
        if (generation !== this.loopGeneration) return;
        if (bundle.runtime.runner.desiredState !== "running") {
          await this.setRunnerState("paused");
          return;
        }
        const threadId = bundle.tab.session.threadId;
        const workingDirectory = bundle.tab.session.workingDirectory;
        if (!threadId || !workingDirectory || bundle.tab.session.state !== "ready") {
          await this.failRunner("SESSION_NOT_READY", "先连接或恢复一个编程代理对话。");
          return;
        }
        await this.setRunnerState("waiting_for_thread");
        try { await this.agent().rpc.waitForThreadIdle(threadId, 120_000); } catch (error) {
          if (generation !== this.loopGeneration) return;
          await this.failRunner("THREAD_NOT_IDLE", error instanceof Error ? error.message : String(error));
          return;
        }
        if (generation !== this.loopGeneration) return;
        const fresh = await this.storage.readTab(this.tabId);
        if (fresh.runtime.runner.desiredState !== "running") { await this.setRunnerState("paused"); return; }
        const prompt = this.pauseAfterPromptId
          ? fresh.prompts.prompts.find((item) => item.id === this.pauseAfterPromptId && item.status === "pending" && (!item.threadId || item.threadId === threadId))
          : fresh.prompts.prompts.find((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId));
        if (!prompt) {
          if (this.pauseAfterPromptId) {
            this.pauseAfterPromptId = null;
            await this.pauseRunner();
            return;
          }
          if (await this.pauseIfEmpty(generation)) return;
          continue;
        }
        const dispatched = await this.prepareDispatch(prompt.id, generation);
        if (!dispatched) continue;
        await this.dispatch(threadId, workingDirectory, dispatched, generation);
        if (this.pauseAfterPromptId === prompt.id) {
          this.pauseAfterPromptId = null;
          await this.pauseRunner();
          return;
        }
      }
    } catch (error) {
      if (this.stopping || generation !== this.loopGeneration) return;
      await this.failRunner("RUNNER_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  private async prepareDispatch(promptId: string, generation: number): Promise<{ prompt: PromptRecord; clientUserMessageId: string } | null> {
    if (generation !== this.loopGeneration) return null;
    return this.storage.withTabLock(this.tabId, async () => {
      if (generation !== this.loopGeneration) return null;
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.runtime.runner.desiredState !== "running") return null;
      const threadId = bundle.tab.session.threadId;
      if (!threadId) return null;
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId
        && item.status === "pending"
        && (!item.threadId || item.threadId === threadId));
      if (!prompt) return null;
      const clientUserMessageId = `codex-promptor-${randomUUID()}`;
      const attempt = newAttempt("queue");
      attempt.status = "dispatching";
      attempt.startedAt = isoNow();
      attempt.clientUserMessageId = clientUserMessageId;
      prompt.attempts.push(attempt);
      prompt.threadId = threadId;
      prompt.status = "dispatching";
      prompt.startedAt = attempt.startedAt;
      prompt.clientUserMessageId = clientUserMessageId;
      prompt.error = null;
      prompt.updatedAt = isoNow();
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
      return { prompt, clientUserMessageId };
    });
  }

  private async startPendingPromptNow(promptId: string, threadId: string): Promise<InsertNowResult> {
    const continueQueue = await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.tab.session.state !== "ready" || bundle.tab.session.threadId !== threadId) throw new Error("SESSION_NOT_READY");
      const targetIndex = bundle.prompts.prompts.findIndex((item) => item.id === promptId);
      const target = bundle.prompts.prompts[targetIndex];
      if (targetIndex < 0 || !target) throw new Error("PROMPT_NOT_FOUND");
      if (target.status !== "pending" || (target.threadId && target.threadId !== threadId)) throw new Error("PROMPT_NOT_PENDING");
      const wasRunning = bundle.runtime.runner.desiredState === "running";
      const firstPendingIndex = bundle.prompts.prompts.findIndex((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId));
      if (firstPendingIndex >= 0 && firstPendingIndex !== targetIndex) {
        bundle.prompts.prompts.splice(targetIndex, 1);
        const insertionIndex = bundle.prompts.prompts.findIndex((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId));
        bundle.prompts.prompts.splice(insertionIndex < 0 ? bundle.prompts.prompts.length : insertionIndex, 0, target);
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await this.storage.writePrompts(this.tabId, bundle.prompts);
      }
      return wasRunning;
    });
    if (!continueQueue) this.pauseAfterPromptId = promptId;
    await this.activate();
    return { mode: "started", turnId: null };
  }

  private async steerPendingPrompt(promptId: string, threadId: string, turnId: string): Promise<void> {
    const clientUserMessageId = `codex-promptor-${randomUUID()}`;
    const reserved = await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.tab.session.state !== "ready" || bundle.tab.session.threadId !== threadId) throw new Error("SESSION_NOT_READY");
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
      if (!prompt) throw new Error("PROMPT_NOT_FOUND");
      if (prompt.status !== "pending" || (prompt.threadId && prompt.threadId !== threadId)) throw new Error("PROMPT_NOT_PENDING");
      const previous = {
        threadId: prompt.threadId,
        startedAt: prompt.startedAt,
        codexTurnId: prompt.codexTurnId,
        clientUserMessageId: prompt.clientUserMessageId,
      };
      const startedAt = isoNow();
      const attempt = newAttempt("queue");
      attempt.delivery = "steer";
      attempt.status = "dispatching";
      attempt.startedAt = startedAt;
      attempt.codexTurnId = turnId;
      attempt.clientUserMessageId = clientUserMessageId;
      prompt.attempts.push(attempt);
      prompt.threadId = threadId;
      prompt.status = "dispatching";
      prompt.startedAt = startedAt;
      prompt.codexTurnId = turnId;
      prompt.clientUserMessageId = clientUserMessageId;
      prompt.error = null;
      prompt.updatedAt = startedAt;
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = startedAt;
      await this.storage.writePrompts(this.tabId, bundle.prompts);
      return { text: prompt.text, startedAt, attemptId: attempt.attemptId, previous };
    });
    try {
      await this.agent().rpc.steerTurn(threadId, turnId, reserved.text, clientUserMessageId);
      await this.storage.withTabLock(this.tabId, async () => {
        const bundle = await this.storage.readTab(this.tabId);
        const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
        const attempt = prompt?.attempts.find((item) => item.attemptId === reserved.attemptId);
        if (!prompt || !attempt || prompt.clientUserMessageId !== clientUserMessageId || prompt.status !== "dispatching") return;
        prompt.status = "running";
        prompt.updatedAt = isoNow();
        attempt.status = "running";
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await this.storage.writePrompts(this.tabId, bundle.prompts);
      });
    } catch (error) {
      const failure = { code: "TURN_STEER_FAILED", message: error instanceof Error ? error.message : String(error) };
      await this.storage.withTabLock(this.tabId, async () => {
        const bundle = await this.storage.readTab(this.tabId);
        const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
        const attempt = prompt?.attempts.find((item) => item.attemptId === reserved.attemptId);
        if (!prompt || !attempt || prompt.clientUserMessageId !== clientUserMessageId) return;
        prompt.status = "pending";
        prompt.threadId = reserved.previous.threadId;
        prompt.startedAt = reserved.previous.startedAt;
        prompt.codexTurnId = reserved.previous.codexTurnId;
        prompt.clientUserMessageId = reserved.previous.clientUserMessageId;
        prompt.error = null;
        prompt.updatedAt = isoNow();
        attempt.status = "failed";
        attempt.completedAt = isoNow();
        attempt.error = failure;
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await this.storage.writePrompts(this.tabId, bundle.prompts);
      });
      throw error;
    }
    const answer = await recordTurnStarted(this.storage, this.tabId, {
      threadId,
      turnId,
      promptId,
      promptText: reserved.text,
      startedAt: reserved.startedAt,
      clientUserMessageId,
    });
    this.emit("answer", answer);
  }

  private async dispatch(threadId: string, cwd: string, dispatched: { prompt: PromptRecord; clientUserMessageId: string }, generation: number): Promise<void> {
    await this.setRunnerState("dispatching", dispatched.prompt.id, null);
    let turnId = "";
    try {
      const result = await this.agent().rpc.startTurn(threadId, dispatched.prompt.text, dispatched.clientUserMessageId, cwd);
      turnId = result.turnId;
      await this.updateAttempt(dispatched.prompt.id, dispatched.clientUserMessageId, (prompt, attempt) => {
        prompt.status = "running";
        prompt.codexTurnId = turnId;
        prompt.updatedAt = isoNow();
        attempt.status = "running";
        attempt.codexTurnId = turnId;
      });
      const startedAnswer = await recordTurnStarted(this.storage, this.tabId, {
        threadId,
        turnId,
        promptId: dispatched.prompt.id,
        promptText: dispatched.prompt.text,
        startedAt: dispatched.prompt.startedAt,
        clientUserMessageId: dispatched.clientUserMessageId,
      });
      this.emit("answer", startedAnswer);
      if (generation !== this.loopGeneration) {
        try { await this.agent().rpc.interruptTurn(threadId, turnId); } catch { /* the detached turn may already be settling */ }
        await this.finalizeInterruptedTurn(threadId, turnId);
        return;
      }
      await this.setRunnerState("running", dispatched.prompt.id, turnId);
      const completed = await this.agent().rpc.waitForTurn(turnId);
      const resultRecord = await recordTurn(this.storage, this.tabId, {
        threadId,
        turn: completed.turn,
        items: completed.items,
        origin: "queue",
        promptId: dispatched.prompt.id,
        promptText: dispatched.prompt.text,
        clientUserMessageId: dispatched.clientUserMessageId,
      });
      let completionError: { code: string; message: string } | null = null;
      const status = turnStatus(completed.turn);
      if (!resultRecord.answer || resultRecord.answer.status !== "completed") {
        if (["interrupted", "canceled", "cancelled"].includes(status)) {
          // recordTurn already persisted the prompt and its active attempt as
          // interrupted. An intentional pause/close is not a runner error.
        } else {
          completionError = resultRecord.answer?.error ?? (status === "failed"
            ? { code: "TURN_FAILED", message: "Agent turn failed before a final answer was produced." }
            : { code: "NO_FINAL_ANSWER", message: "Turn completed without a final answer." });
          if (!resultRecord.answer) await this.markFailure(dispatched.prompt.id, dispatched.clientUserMessageId, completionError.code, completionError.message, turnId);
        }
      }
      if (resultRecord.answer) this.emit("answer", resultRecord.answer);
      await this.clearActive(completionError, dispatched.prompt.id, turnId);
    } catch (error) {
      if (turnId) {
        const current = await this.storage.readTab(this.tabId).catch(() => null);
        const prompt = current?.prompts.prompts.find((item) => item.id === dispatched.prompt.id);
        if (prompt?.status === "interrupted") {
          await this.clearActive(null, dispatched.prompt.id, turnId);
          return;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailure(dispatched.prompt.id, dispatched.clientUserMessageId, turnId ? "TURN_FAILED" : "TURN_START_FAILED", message, turnId || null);
      await this.clearActive({ code: turnId ? "TURN_FAILED" : "TURN_START_FAILED", message }, dispatched.prompt.id, turnId || null);
    }
  }

  private async pauseIfEmpty(generation: number): Promise<boolean> {
    return this.storage.withTabLock(this.tabId, async () => {
      if (generation !== this.loopGeneration) return true;
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.runtime.runner.desiredState !== "running") return true;
      const threadId = bundle.tab.session.threadId;
      if (threadId && bundle.prompts.prompts.some((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId))) return false;
      const runtime: RuntimeFile = {
        ...bundle.runtime,
        revision: bundle.runtime.revision + 1,
        runner: {
          ...bundle.runtime.runner,
          desiredState: "paused",
          state: "paused",
          activePromptId: null,
          activeTurnId: null,
          lastTransitionAt: isoNow(),
        },
      };
      await this.storage.writeRuntime(this.tabId, runtime);
      this.emit("runtime", runtime);
      return true;
    });
  }

  private async updateAttempt(promptId: string, clientId: string, mutator: (prompt: PromptRecord, attempt: PromptRecord["attempts"][number]) => void): Promise<void> {
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
      const attempt = prompt?.attempts.find((item) => item.clientUserMessageId === clientId);
      if (!prompt || !attempt) return;
      mutator(prompt, attempt);
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
    });
  }

  private async markFailure(promptId: string, clientId: string, code: string, message: string, turnId: string | null = null): Promise<void> {
    let failedAnswer: AnswerRecord | null = null;
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
      const attempt = prompt?.attempts.find((item) => item.clientUserMessageId === clientId);
      if (!prompt || !attempt) return;
      const completedAt = isoNow();
      prompt.status = "failed";
      prompt.completedAt = completedAt;
      prompt.error = { code, message };
      prompt.updatedAt = completedAt;
      attempt.status = "failed";
      attempt.completedAt = completedAt;
      attempt.error = { code, message };
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = completedAt;
      await this.storage.writePrompts(this.tabId, bundle.prompts);
      if (!turnId || !prompt.threadId) return;
      failedAnswer = bundle.answers.answers.find((answer) => answer.threadId === prompt.threadId && answer.codexTurnId === turnId) ?? null;
      if (!failedAnswer) {
        const linked = bundle.prompts.prompts.filter((item) => item.codexTurnId === turnId && item.threadId === prompt.threadId);
        failedAnswer = {
          id: randomUUID(),
          promptId: prompt.id,
          threadId: prompt.threadId,
          codexTurnId: turnId,
          origin: prompt.origin,
          prompt: linked.map((item) => item.text).filter(Boolean).join("\n\n--- 追加输入 ---\n\n") || prompt.text,
          status: "failed",
          finalAnswer: "",
          captureMode: null,
          startedAt: prompt.startedAt,
          completedAt,
          recordedAt: completedAt,
          clientUserMessageId: clientId,
          error: { code, message },
          metadata: {
            promptIds: linked.map((item) => item.id),
            steeredPromptIds: linked.filter((item) => item.attempts.some((entry) => entry.codexTurnId === turnId && entry.delivery === "steer")).map((item) => item.id),
          },
        };
        bundle.answers.answers.push(failedAnswer);
      } else {
        failedAnswer.status = "failed";
        failedAnswer.completedAt = completedAt;
        failedAnswer.error = { code, message };
      }
      bundle.answers.revision += 1;
      bundle.answers.updatedAt = completedAt;
      await this.storage.writeAnswers(this.tabId, bundle.answers);
    });
    if (failedAnswer) this.emit("answer", failedAnswer);
    this.emit("error", { code, message });
  }

  private async finalizeInterruptedTurn(threadId: string, turnId: string): Promise<void> {
    let interruptedAnswer: AnswerRecord | null = null;
    let interruptedRuntime: RuntimeFile | null = null;
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const linked = bundle.prompts.prompts.filter((prompt) => prompt.threadId === threadId
        && prompt.codexTurnId === turnId
        && (prompt.status === "dispatching" || prompt.status === "running"));
      if (!linked.length) return;
      const completedAt = isoNow();
      const error = { code: "TURN_INTERRUPTED", message: "Agent turn was interrupted before a final answer was produced." };
      for (const prompt of linked) {
        prompt.status = "interrupted";
        prompt.completedAt = completedAt;
        prompt.updatedAt = completedAt;
        prompt.error = error;
        for (const attempt of prompt.attempts.filter((item) => item.codexTurnId === turnId
          && (item.status === "dispatching" || item.status === "running"))) {
          attempt.status = "interrupted";
          attempt.completedAt = completedAt;
          attempt.error = error;
        }
      }
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = completedAt;
      await this.storage.writePrompts(this.tabId, bundle.prompts);

      const primary = linked.find((prompt) => prompt.attempts.some((attempt) => attempt.codexTurnId === turnId && attempt.delivery === "turn")) ?? linked[0];
      const promptText = linked.map((prompt) => prompt.text.trim()).filter(Boolean).join("\n\n--- 追加输入 ---\n\n") || primary.text;
      const metadata = {
        promptIds: linked.map((prompt) => prompt.id),
        steeredPromptIds: linked.filter((prompt) => prompt.attempts.some((attempt) => attempt.codexTurnId === turnId && attempt.delivery === "steer")).map((prompt) => prompt.id),
      };
      interruptedAnswer = bundle.answers.answers.find((answer) => answer.threadId === threadId && answer.codexTurnId === turnId) ?? null;
      if (!interruptedAnswer) {
        interruptedAnswer = {
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
          completedAt,
          recordedAt: completedAt,
          clientUserMessageId: primary.clientUserMessageId,
          error,
          metadata,
        };
        bundle.answers.answers.push(interruptedAnswer);
      } else {
        interruptedAnswer.promptId = primary.id;
        interruptedAnswer.origin = primary.origin;
        interruptedAnswer.prompt = promptText;
        interruptedAnswer.status = "interrupted";
        interruptedAnswer.finalAnswer = "";
        interruptedAnswer.captureMode = null;
        interruptedAnswer.startedAt = interruptedAnswer.startedAt ?? primary.startedAt;
        interruptedAnswer.completedAt = completedAt;
        interruptedAnswer.clientUserMessageId = interruptedAnswer.clientUserMessageId ?? primary.clientUserMessageId;
        interruptedAnswer.error = error;
        interruptedAnswer.metadata = metadata;
      }
      bundle.answers.revision += 1;
      bundle.answers.updatedAt = completedAt;
      await this.storage.writeAnswers(this.tabId, bundle.answers);

      const ownsActivePrompt = linked.some((prompt) => prompt.id === bundle.runtime.runner.activePromptId);
      if (bundle.runtime.runner.activeTurnId === turnId || ownsActivePrompt) {
        interruptedRuntime = {
          ...bundle.runtime,
          revision: bundle.runtime.revision + 1,
          runner: {
            ...bundle.runtime.runner,
            desiredState: "paused",
            state: "paused",
            activePromptId: null,
            activeTurnId: null,
            lastError: null,
            lastTransitionAt: completedAt,
          },
        };
        await this.storage.writeRuntime(this.tabId, interruptedRuntime);
      }
    });
    if (interruptedAnswer) this.emit("answer", interruptedAnswer);
    if (interruptedRuntime) this.emit("runtime", interruptedRuntime);
  }

  private async clearActive(error: { code: string; message: string } | null, promptId: string, turnId: string | null): Promise<void> {
    await this.updateRuntime((runtime) => {
      const ownsPrompt = runtime.runner.activePromptId === promptId;
      const ownsTurn = !turnId || runtime.runner.activeTurnId === turnId || runtime.runner.activeTurnId === null;
      if (!ownsPrompt || !ownsTurn) return runtime;
      return {
        ...runtime,
        runner: {
          ...runtime.runner,
          state: error ? "error" : runtime.runner.desiredState === "running" ? "dispatching" : "paused",
          activePromptId: null,
          activeTurnId: null,
          lastError: error,
          lastTransitionAt: isoNow(),
        },
      };
    });
  }

  private async setRunnerState(state: RuntimeFile["runner"]["state"], activePromptId: string | null = null, activeTurnId: string | null = null): Promise<void> {
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: { ...runtime.runner, state, activePromptId, activeTurnId, lastTransitionAt: isoNow() },
    }));
  }

  private async failRunner(code: string, message: string): Promise<void> {
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: { ...runtime.runner, desiredState: "paused", state: "error", lastError: { code, message }, activePromptId: null, activeTurnId: null, lastTransitionAt: isoNow() },
    }));
    this.emit("error", { code, message });
  }

  private async updateRuntime(mutator: (runtime: RuntimeFile) => RuntimeFile): Promise<RuntimeFile> {
    return this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const runtime = mutator(bundle.runtime);
      runtime.revision += 1;
      await this.storage.writeRuntime(this.tabId, runtime);
      this.emit("runtime", runtime);
      return runtime;
    });
  }

  private agent(): QueueBinding {
    return typeof this.queueBinding === "function" ? this.queueBinding() : this.queueBinding;
  }
}

export class RunnerManager {
  private readonly runners = new Map<string, QueueRunner>();
  constructor(private readonly storage: StorageService, private readonly resolveAgent: (tabId: string) => QueueBinding, private readonly onEvent: (event: RunnerEvent) => void) {}

  get(tabId: string): QueueRunner {
    let runner = this.runners.get(tabId);
    if (!runner) {
      runner = new QueueRunner(tabId, this.storage, () => this.resolveAgent(tabId));
      runner.on("runtime", (runtime) => this.onEvent({ tabId, type: "runtime", data: runtime }));
      runner.on("answer", (answer) => this.onEvent({ tabId, type: "answer", data: answer }));
      runner.on("error", (error) => this.onEvent({ tabId, type: "error", data: error }));
      this.runners.set(tabId, runner);
    }
    return runner;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map((runner) => runner.stop()));
  }

  async remove(tabId: string): Promise<void> {
    const runner = this.runners.get(tabId);
    if (!runner) return;
    await runner.stop();
    this.runners.delete(tabId);
  }
}
