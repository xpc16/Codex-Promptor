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
  /** Interrupt a PTY submission before its hook/record has yielded a turn id. */
  interruptPendingSubmission?(threadId: string): Promise<boolean>;
  waitForTurn(turnId: string): Promise<{ turn: any; items: any[] }>;
};
export type QueueBinding = { rpc: QueueRpc };
type QueueResolver = QueueBinding | (() => QueueBinding);
export const QUEUE_INTER_PROMPT_DELAY_MS = 5_000;

export class QueueRunner extends EventEmitter {
  private loopPromise: Promise<void> | null = null;
  private loopGeneration = 0;
  private stopping = false;
  /** Pending prompts temporarily allowed to run without changing desiredState. */
  private readonly oneShotPromptIds = new Set<string>();

  /**
   * Whether the loop should keep going. Two independent reasons: the queue is
   * set to roll, or a single requested prompt has not finished yet.
   */
  private keepsRunning(runtime: RuntimeFile): boolean {
    return runtime.runner.desiredState === "running" || this.oneShotPromptIds.size > 0;
  }

  constructor(
    readonly tabId: string,
    private readonly storage: StorageService,
    private readonly queueBinding: QueueResolver,
    private readonly freezeTimeoutMs = 5_000,
    private readonly interPromptDelayMs = QUEUE_INTER_PROMPT_DELAY_MS,
  ) {
    super();
    // EventEmitter treats an unobserved `error` event as an exception. QueueRunner
    // can also be used directly in tests and maintenance scripts, so keep the
    // event non-fatal until RunnerManager attaches its forwarding listener.
    this.on("error", () => undefined);
  }

  async start(): Promise<void> {
    await this.clearOneShotIntent();
    await this.activate();
  }

  /**
   * Register a crash-recoverable timer batch and wake the existing loop. The
   * promise covers registration only; callers never wait for provider turns.
   */
  async runOneShotBatch(promptIds: readonly string[]): Promise<void> {
    for (const id of promptIds) if (id) this.oneShotPromptIds.add(id);
    if (this.oneShotPromptIds.size === 0 || this.stopping) return;
    this.launchLoop();
  }

  private async activate(): Promise<void> {
    if (this.loopPromise) {
      const current = await this.storage.readTab(this.tabId);
      if (current.runtime.runner.desiredState === "running") return;
      // A one-shot prompt can already own the live loop while the queue itself
      // is paused or armed. Starting at that point means "keep going after
      // this turn"; it must not replace the real running/dispatching state
      // (or its active ids) with the idle-loop bootstrap state.
      await this.updateRuntime((runtime) => ({
        ...runtime,
        runner: { ...runtime.runner, desiredState: "running", lastError: null, lastTransitionAt: isoNow() },
      }));
      this.stopping = false;
      // This is normally a no-op. It also closes the narrow race where the
      // observed loop settles while the runtime update above is awaiting I/O.
      this.launchLoop();
      return;
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
        if (this.keepsRunning(current.runtime)) this.launchLoop();
      } catch { /* a deleted tab must not restart its runner */ }
    });
    this.loopPromise = loop;
  }

  async pause(): Promise<void> {
    await this.clearOneShotIntent();
    await this.pauseRunner();
  }

  /**
   * The requested prompt is done. Only the transient run state is cleared --
   * desiredState was never touched, so there is nothing to put back.
   */
  private async settleAfterOneShot(): Promise<void> {
    await this.setRunnerState("paused");
  }

  private async pauseRunner(): Promise<void> {
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: {
        ...runtime.runner,
        desiredState: "paused",
        state: runtime.runner.activePromptId ? "pausing" : "paused",
        lastTransitionAt: isoNow(),
      },
    }));
  }

  async configure(onFailure: "pause" | "continue"): Promise<RuntimeFile> {
    return this.updateRuntime((runtime) => ({ ...runtime, queueConfig: { onFailure } }));
  }

  async insertNow(promptId: string, editedText?: string): Promise<InsertNowResult> {
    const replacementText = editedText === undefined ? undefined : editedText.trim();
    if (editedText !== undefined && !replacementText) throw new Error("PROMPT_EMPTY");
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
        await this.steerPendingPrompt(promptId, threadId, activeTurnId, replacementText);
        return { mode: "steered", turnId: activeTurnId };
      } catch (error) {
        // The active turn can finish between discovery and turn/steer. In that
        // narrow race, honor "run now" by starting the prompt normally.
        if (this.agent().rpc.activeTurnIds(threadId).length) throw error;
      }
    }
    return this.startPendingPromptNow(promptId, threadId, replacementText);
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
    const interruptPendingSubmission = this.agent().rpc.interruptPendingSubmission;
    // turn/start can be in flight after the prompt was reserved but before its
    // turn id is persisted. Keep Interrupt effective in that short window by
    // waiting for the id instead of abandoning a request that may already have
    // reached the provider.
    if (threadId && bundle.runtime.runner.activePromptId && !turnId && activeLoop && !interruptPendingSubmission) {
      const deadline = Date.now() + this.freezeTimeoutMs;
      while (Date.now() < deadline && !turnId) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
        bundle = await this.storage.readTab(this.tabId);
        if (!bundle.runtime.runner.activePromptId) break;
        turnId = bundle.runtime.runner.activeTurnId;
      }
    }
    if (!threadId || !turnId) {
      if (threadId && bundle.runtime.runner.activePromptId && interruptPendingSubmission) {
        const interrupted = await interruptPendingSubmission(threadId).catch(() => false);
        if (interrupted) {
          let loopSettled = !activeLoop;
          if (activeLoop) {
            await Promise.race([
              activeLoop.then(() => { loopSettled = true; }, () => { loopSettled = true; }),
              new Promise<void>((resolve) => setTimeout(resolve, this.freezeTimeoutMs)),
            ]);
          }
          if (!loopSettled) this.abandonLoop(activeLoop);
          return true;
        }
      }
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
        if (!this.keepsRunning(bundle.runtime)) {
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
        if (!this.keepsRunning(fresh.runtime)) { await this.setRunnerState("paused"); return; }
        const prompt = fresh.runtime.runner.desiredState === "running"
          ? fresh.prompts.prompts.find((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId))
          : fresh.prompts.prompts.find((item) => this.oneShotPromptIds.has(item.id)
            && item.status === "pending"
            && (!item.threadId || item.threadId === threadId));
        if (!prompt) {
          if (this.oneShotPromptIds.size > 0) await this.discardUnavailableOneShots(threadId);
          if (fresh.runtime.runner.desiredState !== "running") {
            await this.settleAfterOneShot();
            return;
          }
          if (await this.armIfEmpty(generation)) return;
          continue;
        }
        const dispatched = await this.prepareDispatch(prompt.id, generation);
        if (!dispatched) continue;
        const failed = await this.dispatch(threadId, workingDirectory, dispatched, generation);
        if (failed) {
          const after = await this.storage.readRuntime(this.tabId);
          if (after.queueConfig.onFailure === "pause") {
            await this.pauseAfterFailure();
            return;
          }
        } else {
          await this.waitAfterCompletedPrompt(dispatched.prompt.id, threadId, generation);
        }
      }
    } catch (error) {
      if (this.stopping || generation !== this.loopGeneration) return;
      await this.failRunner("RUNNER_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Give the provider five seconds to settle after a successful turn before
   * reserving the next queued prompt. The deadline is anchored to the stored
   * completion time, so history persistence does not add extra delay. Prompt
   * order is deliberately read again after the wait.
   */
  private async waitAfterCompletedPrompt(promptId: string, threadId: string, generation: number): Promise<void> {
    if (this.interPromptDelayMs <= 0 || generation !== this.loopGeneration || this.stopping) return;
    const delay = await this.storage.withTabLock(this.tabId, async () => {
      if (generation !== this.loopGeneration || this.stopping) return 0;
      const bundle = await this.storage.readTab(this.tabId);
      // A paused timer one-shot is not a rolling queue. It keeps its existing
      // batch semantics unless the user explicitly presses Start mid-turn.
      if (bundle.runtime.runner.desiredState !== "running") return 0;
      const completed = bundle.prompts.prompts.find((prompt) => prompt.id === promptId);
      if (completed?.status !== "completed" || !completed.completedAt) return 0;
      const eligible = (prompt: PromptRecord) => prompt.status === "pending"
        && (!prompt.threadId || prompt.threadId === threadId);
      if (!bundle.prompts.prompts.some(eligible)) return 0;
      const completedAt = Date.parse(completed.completedAt);
      const elapsed = Number.isFinite(completedAt) ? Math.max(0, Date.now() - completedAt) : 0;
      const remaining = Math.max(0, this.interPromptDelayMs - elapsed);
      if (remaining === 0) return 0;
      const runtime: RuntimeFile = {
        ...bundle.runtime,
        revision: bundle.runtime.revision + 1,
        runner: {
          ...bundle.runtime.runner,
          state: "waiting_for_prompt",
          activePromptId: null,
          activeTurnId: null,
          lastTransitionAt: isoNow(),
        },
      };
      await this.storage.writeRuntime(this.tabId, runtime);
      this.emit("runtime", runtime);
      return remaining;
    });
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }

  private async prepareDispatch(promptId: string, generation: number): Promise<{ prompt: PromptRecord; clientUserMessageId: string } | null> {
    if (generation !== this.loopGeneration) return null;
    return this.storage.withTabLock(this.tabId, async () => {
      if (generation !== this.loopGeneration) return null;
      const bundle = await this.storage.readTab(this.tabId);
      if (!this.keepsRunning(bundle.runtime)) return null;
      const threadId = bundle.tab.session.threadId;
      if (!threadId) return null;
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId
        && item.status === "pending"
        && (!item.threadId || item.threadId === threadId));
      if (!prompt) return null;
      const clientUserMessageId = `codex-promptor-${randomUUID()}`;
      const attempt = newAttempt(prompt.origin);
      attempt.status = "dispatching";
      attempt.startedAt = isoNow();
      attempt.clientUserMessageId = clientUserMessageId;
      prompt.attempts.push(attempt);
      prompt.threadId = threadId;
      prompt.status = "dispatching";
      prompt.startedAt = attempt.startedAt;
      prompt.clientUserMessageId = clientUserMessageId;
      prompt.error = null;
      delete prompt.timerAutoRun;
      prompt.updatedAt = isoNow();
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
      this.oneShotPromptIds.delete(prompt.id);
      return { prompt, clientUserMessageId };
    });
  }

  private async startPendingPromptNow(promptId: string, threadId: string, replacementText?: string): Promise<InsertNowResult> {
    const continueQueue = await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.tab.session.state !== "ready" || bundle.tab.session.threadId !== threadId) throw new Error("SESSION_NOT_READY");
      const targetIndex = bundle.prompts.prompts.findIndex((item) => item.id === promptId);
      const target = bundle.prompts.prompts[targetIndex];
      if (targetIndex < 0 || !target) throw new Error("PROMPT_NOT_FOUND");
      if (target.status !== "pending" || (target.threadId && target.threadId !== threadId)) throw new Error("PROMPT_NOT_PENDING");
      const wasRunning = bundle.runtime.runner.desiredState === "running";
      let changed = false;
      if (replacementText !== undefined && replacementText !== target.text) {
        target.text = replacementText;
        target.updatedAt = isoNow();
        changed = true;
      }
      const firstPendingIndex = bundle.prompts.prompts.findIndex((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId));
      if (firstPendingIndex >= 0 && firstPendingIndex !== targetIndex) {
        bundle.prompts.prompts.splice(targetIndex, 1);
        const insertionIndex = bundle.prompts.prompts.findIndex((item) => item.status === "pending" && (!item.threadId || item.threadId === threadId));
        bundle.prompts.prompts.splice(insertionIndex < 0 ? bundle.prompts.prompts.length : insertionIndex, 0, target);
        changed = true;
      }
      if (changed) {
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await this.storage.writePrompts(this.tabId, bundle.prompts);
      }
      return wasRunning;
    });
    if (continueQueue) {
      // Already rolling: the prompt was moved to the front and the running
      // loop will take it next. Nothing about the queue's setting changes.
      await this.activate();
      return { mode: "started", turnId: null };
    }
    // Idle: drive the loop directly for this one prompt. Going through
    // activate() would write desiredState "running", which is what used to
    // make a stopped queue read as rolling for the length of the turn.
    this.oneShotPromptIds.add(promptId);
    this.stopping = false;
    this.launchLoop();
    return { mode: "started", turnId: null };
  }

  private async steerPendingPrompt(promptId: string, threadId: string, turnId: string, replacementText?: string): Promise<void> {
    const clientUserMessageId = `codex-promptor-${randomUUID()}`;
    const reserved = await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.tab.session.state !== "ready" || bundle.tab.session.threadId !== threadId) throw new Error("SESSION_NOT_READY");
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId);
      if (!prompt) throw new Error("PROMPT_NOT_FOUND");
      if (prompt.status !== "pending" || (prompt.threadId && prompt.threadId !== threadId)) throw new Error("PROMPT_NOT_PENDING");
      if (replacementText !== undefined) prompt.text = replacementText;
      const previous = {
        threadId: prompt.threadId,
        startedAt: prompt.startedAt,
        codexTurnId: prompt.codexTurnId,
        clientUserMessageId: prompt.clientUserMessageId,
      };
      const startedAt = isoNow();
      const attempt = newAttempt(prompt.origin);
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
      delete prompt.timerAutoRun;
      prompt.updatedAt = startedAt;
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = startedAt;
      await this.storage.writePrompts(this.tabId, bundle.prompts);
      this.oneShotPromptIds.delete(prompt.id);
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

  private async dispatch(threadId: string, cwd: string, dispatched: { prompt: PromptRecord; clientUserMessageId: string }, generation: number): Promise<boolean> {
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
        return false;
      }
      await this.setRunnerState("running", dispatched.prompt.id, turnId);
      const completed = await this.agent().rpc.waitForTurn(turnId);
      const resultRecord = await recordTurn(this.storage, this.tabId, {
        threadId,
        turn: completed.turn,
        items: completed.items,
        origin: dispatched.prompt.origin,
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
      return completionError !== null;
    } catch (error) {
      if (turnId) {
        const current = await this.storage.readTab(this.tabId).catch(() => null);
        const prompt = current?.prompts.prompts.find((item) => item.id === dispatched.prompt.id);
        if (prompt?.status === "interrupted") {
          await this.clearActive(null, dispatched.prompt.id, turnId);
          return false;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!turnId && message === "PROMPT_SUBMISSION_INTERRUPTED") {
        await this.finalizeInterruptedSubmission(threadId, dispatched.prompt.id, dispatched.clientUserMessageId);
        return false;
      }
      await this.markFailure(dispatched.prompt.id, dispatched.clientUserMessageId, turnId ? "TURN_FAILED" : "TURN_START_FAILED", message, turnId || null);
      await this.clearActive({ code: turnId ? "TURN_FAILED" : "TURN_START_FAILED", message }, dispatched.prompt.id, turnId || null);
      return true;
    }
  }

  /**
   * The queue ran out of work on its own. That is not the same as the user
   * stopping it, so it goes back to armed rather than paused: the next prompt
   * added should just run. Only an explicit pause, an interruption or a
   * failure leaves it stopped, and each of those returns early here because
   * they have already moved desiredState away from "running".
   */
  private async armIfEmpty(generation: number): Promise<boolean> {
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
          desiredState: "armed",
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

  private async finalizeInterruptedSubmission(threadId: string, promptId: string, clientId: string): Promise<void> {
    // There is intentionally no invented provider turn id. This names a local
    // submission lifecycle record so the interrupted attempt can be displayed
    // and retried without pretending the provider acknowledged it.
    const localTurnId = `submission-interrupted:${clientId}`;
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId && item.clientUserMessageId === clientId);
      const attempt = prompt?.attempts.find((item) => item.clientUserMessageId === clientId && item.status === "dispatching");
      if (!prompt || !attempt || prompt.status !== "dispatching") return;
      prompt.codexTurnId = localTurnId;
      attempt.codexTurnId = localTurnId;
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
    });
    await this.finalizeInterruptedTurn(threadId, localTurnId);
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
          // Whatever this prompt was waiting on, it is no longer waiting.
          stalledSince: null,
          lastError: error,
          lastTransitionAt: isoNow(),
        },
      };
    });
  }

  private async setRunnerState(state: RuntimeFile["runner"]["state"], activePromptId: string | null = null, activeTurnId: string | null = null): Promise<void> {
    // A runner that is working again is not a runner that failed. The error is
    // what explains a stopped queue, so it lasts exactly as long as the stop
    // does; keeping it any longer made one old failure read as a broken
    // conversation through every successful turn that came after it.
    const working = state === "dispatching" || state === "running";
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: {
        ...runtime.runner,
        state,
        activePromptId,
        activeTurnId,
        ...(working ? { lastError: null, stalledSince: null } : {}),
        lastTransitionAt: isoNow(),
      },
    }));
  }

  private async failRunner(code: string, message: string): Promise<void> {
    await this.clearOneShotIntent();
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: { ...runtime.runner, desiredState: "paused", state: "error", lastError: { code, message }, activePromptId: null, activeTurnId: null, lastTransitionAt: isoNow() },
    }));
    this.emit("error", { code, message });
  }

  private async clearOneShotIntent(): Promise<void> {
    this.oneShotPromptIds.clear();
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      let changed = false;
      for (const prompt of bundle.prompts.prompts) {
        if (prompt.timerAutoRun !== true) continue;
        delete prompt.timerAutoRun;
        prompt.updatedAt = isoNow();
        changed = true;
      }
      if (!changed) return;
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
    });
  }

  private async discardUnavailableOneShots(threadId: string): Promise<void> {
    const unavailable = new Set(this.oneShotPromptIds);
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      let changed = false;
      for (const prompt of bundle.prompts.prompts) {
        if (!unavailable.has(prompt.id)) continue;
        const eligible = prompt.status === "pending" && (!prompt.threadId || prompt.threadId === threadId);
        if (eligible) {
          unavailable.delete(prompt.id);
          continue;
        }
        if (prompt.timerAutoRun === true) {
          delete prompt.timerAutoRun;
          prompt.updatedAt = isoNow();
          changed = true;
        }
      }
      for (const id of unavailable) this.oneShotPromptIds.delete(id);
      if (!changed) return;
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await this.storage.writePrompts(this.tabId, bundle.prompts);
    });
  }

  private async pauseAfterFailure(): Promise<void> {
    this.oneShotPromptIds.clear();
    await this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      let promptsChanged = false;
      for (const prompt of bundle.prompts.prompts) {
        if (prompt.timerAutoRun !== true) continue;
        delete prompt.timerAutoRun;
        prompt.updatedAt = isoNow();
        promptsChanged = true;
      }
      if (promptsChanged) {
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await this.storage.writePrompts(this.tabId, bundle.prompts);
      }
      const runtime: RuntimeFile = {
        ...bundle.runtime,
        revision: bundle.runtime.revision + 1,
        runner: {
          ...bundle.runtime.runner,
          desiredState: "paused",
          state: "error",
          activePromptId: null,
          activeTurnId: null,
          lastTransitionAt: isoNow(),
        },
      };
      await this.storage.writeRuntime(this.tabId, runtime);
      this.emit("runtime", runtime);
    });
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
