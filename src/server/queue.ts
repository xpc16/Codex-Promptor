import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { isoNow, newAttempt, type PromptRecord, type RuntimeFile } from "../shared/schemas.js";
import { AppServerManager } from "./codex.js";
import { recordTurn } from "./history.js";
import { StorageService } from "./storage.js";

export type RunnerEvent = { tabId: string; type: "runtime" | "answer" | "error"; data?: unknown };
type CodexBinding = Pick<AppServerManager, "rpc">;
type CodexResolver = CodexBinding | (() => CodexBinding);

export class QueueRunner extends EventEmitter {
  private loopPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(
    readonly tabId: string,
    private readonly storage: StorageService,
    private readonly codexBinding: CodexResolver,
  ) {
    super();
    // EventEmitter treats an unobserved `error` event as an exception. QueueRunner
    // can also be used directly in tests and maintenance scripts, so keep the
    // event non-fatal until RunnerManager attaches its forwarding listener.
    this.on("error", () => undefined);
  }

  async start(): Promise<void> {
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
    this.loopPromise = this.runLoop().finally(async () => {
      this.loopPromise = null;
      if (this.stopping) return;
      try {
        const current = await this.storage.readTab(this.tabId);
        if (current.runtime.runner.desiredState === "running") this.launchLoop();
      } catch { /* a deleted tab must not restart its runner */ }
    });
  }

  async pause(): Promise<void> {
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
    await this.pause();
    const bundle = await this.storage.readTab(this.tabId);
    const threadId = bundle.tab.session.threadId;
    const turnId = bundle.runtime.runner.activeTurnId;
    if (threadId && turnId) {
      try { await this.codex().rpc.interruptTurn(threadId, turnId); } catch { /* the turn may have completed at the pause boundary */ }
    }
    if (this.loopPromise) {
      await Promise.race([
        this.loopPromise.catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ]);
    }
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.stopping) {
        const bundle = await this.storage.readTab(this.tabId);
        if (bundle.runtime.runner.desiredState !== "running") {
          await this.setRunnerState("paused");
          return;
        }
        const threadId = bundle.tab.session.threadId;
        const workingDirectory = bundle.tab.session.workingDirectory;
        if (!threadId || !workingDirectory || bundle.tab.session.state !== "ready") {
          await this.failRunner("SESSION_NOT_READY", "先连接或恢复一个 Codex 对话。");
          return;
        }
        await this.setRunnerState("waiting_for_thread");
        try { await this.codex().rpc.waitForThreadIdle(threadId, 120_000); } catch (error) {
          await this.failRunner("THREAD_NOT_IDLE", error instanceof Error ? error.message : String(error));
          return;
        }
        const fresh = await this.storage.readTab(this.tabId);
        if (fresh.runtime.runner.desiredState !== "running") { await this.setRunnerState("paused"); return; }
        const prompt = fresh.prompts.prompts.find((item) => item.status === "pending");
        if (!prompt) {
          if (await this.pauseIfEmpty()) return;
          continue;
        }
        const dispatched = await this.prepareDispatch(prompt.id);
        if (!dispatched) continue;
        await this.dispatch(threadId, workingDirectory, dispatched);
      }
    } catch (error) {
      if (this.stopping) return;
      await this.failRunner("RUNNER_ERROR", error instanceof Error ? error.message : String(error));
    }
  }

  private async prepareDispatch(promptId: string): Promise<{ prompt: PromptRecord; clientUserMessageId: string } | null> {
    return this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.runtime.runner.desiredState !== "running") return null;
      const prompt = bundle.prompts.prompts.find((item) => item.id === promptId && item.status === "pending");
      if (!prompt) return null;
      const clientUserMessageId = `codex-promptor-${randomUUID()}`;
      const attempt = newAttempt("queue");
      attempt.status = "dispatching";
      attempt.startedAt = isoNow();
      attempt.clientUserMessageId = clientUserMessageId;
      prompt.attempts.push(attempt);
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

  private async dispatch(threadId: string, cwd: string, dispatched: { prompt: PromptRecord; clientUserMessageId: string }): Promise<void> {
    await this.setRunnerState("dispatching", dispatched.prompt.id, null);
    let turnId = "";
    try {
      const result = await this.codex().rpc.startTurn(threadId, dispatched.prompt.text, dispatched.clientUserMessageId, cwd);
      turnId = result.turnId;
      await this.updateAttempt(dispatched.prompt.id, dispatched.clientUserMessageId, (prompt, attempt) => {
        prompt.status = "running";
        prompt.codexTurnId = turnId;
        prompt.updatedAt = isoNow();
        attempt.status = "running";
        attempt.codexTurnId = turnId;
      });
      await this.setRunnerState("running", dispatched.prompt.id, turnId);
      const completed = await this.codex().rpc.waitForTurn(turnId);
      const resultRecord = await recordTurn(this.storage, this.tabId, {
        threadId,
        turn: completed.turn,
        items: completed.items,
        origin: "queue",
        promptId: dispatched.prompt.id,
        promptText: dispatched.prompt.text,
        clientUserMessageId: dispatched.clientUserMessageId,
      });
      if (!resultRecord.answer) {
        await this.markFailure(dispatched.prompt.id, dispatched.clientUserMessageId, "NO_FINAL_ANSWER", "Turn completed without a final answer.");
      } else {
        this.emit("answer", resultRecord.answer);
      }
      await this.clearActive(resultRecord.answer ? null : { code: "NO_FINAL_ANSWER", message: "Turn completed without a final answer." });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.markFailure(dispatched.prompt.id, dispatched.clientUserMessageId, turnId ? "TURN_FAILED" : "TURN_START_FAILED", message);
      await this.clearActive({ code: turnId ? "TURN_FAILED" : "TURN_START_FAILED", message });
    }
  }

  private async pauseIfEmpty(): Promise<boolean> {
    return this.storage.withTabLock(this.tabId, async () => {
      const bundle = await this.storage.readTab(this.tabId);
      if (bundle.runtime.runner.desiredState !== "running") return true;
      if (bundle.prompts.prompts.some((item) => item.status === "pending")) return false;
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

  private async markFailure(promptId: string, clientId: string, code: string, message: string): Promise<void> {
    await this.updateAttempt(promptId, clientId, (prompt, attempt) => {
      prompt.status = "failed";
      prompt.error = { code, message };
      prompt.updatedAt = isoNow();
      attempt.status = "failed";
      attempt.completedAt = isoNow();
      attempt.error = { code, message };
    });
    this.emit("error", { code, message });
  }

  private async clearActive(error: { code: string; message: string } | null): Promise<void> {
    await this.updateRuntime((runtime) => ({
      ...runtime,
      runner: {
        ...runtime.runner,
        state: error ? "error" : runtime.runner.desiredState === "running" ? "dispatching" : "paused",
        activePromptId: null,
        activeTurnId: null,
        lastError: error,
        lastTransitionAt: isoNow(),
      },
    }));
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

  private codex(): CodexBinding {
    return typeof this.codexBinding === "function" ? this.codexBinding() : this.codexBinding;
  }
}

export class RunnerManager {
  private readonly runners = new Map<string, QueueRunner>();
  constructor(private readonly storage: StorageService, private readonly resolveCodex: (tabId: string) => CodexBinding, private readonly onEvent: (event: RunnerEvent) => void) {}

  get(tabId: string): QueueRunner {
    let runner = this.runners.get(tabId);
    if (!runner) {
      runner = new QueueRunner(tabId, this.storage, () => this.resolveCodex(tabId));
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
