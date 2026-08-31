import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentProcessLaunch, PtyManager } from "./pty.js";
import type { QueueBinding, QueueRpc } from "./queue.js";
import { clearSubmitTimers, sameSubmittedPrompt, scheduleSubmitRecovery, type SubmitEvidence, type SubmitTimers } from "./prompt-submit.js";
import { inspectCodexSubmission, reconcileCodexTurn, transcriptCursor, type TranscriptCursor } from "./transcript-reconciliation.js";

const COMPLETED_CACHE_LIMIT = 100;
const execFileAsync = promisify(execFile);

export type CodexTuiLaunch = { mode: "new" } | { mode: "resume"; sessionId: string };
export type CodexTuiSessionInfo = {
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
  source: string | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

type TurnState = {
  turnId: string;
  threadId: string;
  prompt: string;
  clientUserMessageId: string | null;
  origin: "queue" | "manual";
  startedAt: string;
  recordCursor: TranscriptCursor;
  completion: Deferred<{ turn: any; items: any[] }>;
};

type Submission = {
  kind: "turn" | "steer";
  prompt: string;
  clientUserMessageId: string;
  logicalTurnId: string | null;
  recordCursor: TranscriptCursor;
  accepted: Deferred<string>;
  timers: SubmitTimers;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const value: Deferred<T> = {
    settled: false,
    promise: new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; }),
    resolve: (result) => {
      if (value.settled) return;
      value.settled = true;
      resolvePromise(result);
    },
    reject: (error) => {
      if (value.settled) return;
      value.settled = true;
      rejectPromise(error);
    },
  };
  return value;
}

/** Native Codex TUI adapter used by the experimental PTY/hooks transport. */
export class CodexTuiManager extends EventEmitter implements QueueBinding {
  readonly rpc: QueueRpc;
  private launchReady: Deferred<CodexTuiSessionInfo> | null = null;
  private attached: CodexTuiSessionInfo | null = null;
  private readonly turns = new Map<string, TurnState>();
  private readonly completed = new Map<string, { turn: any; items: any[] }>();
  private submission: Submission | null = null;
  private sessionCursor: TranscriptCursor = { path: null, offset: 0 };
  private submissionReservation = 0;
  private reservationInFlight = false;

  constructor(readonly tabId: string, private readonly pty: PtyManager) {
    super();
    this.rpc = {
      activeTurnIds: (threadId) => this.activeTurnIds(threadId),
      waitForThreadIdle: (threadId, timeoutMs) => this.waitForThreadIdle(threadId, timeoutMs),
      startTurn: (threadId, text, clientUserMessageId) => this.startTurn(threadId, text, clientUserMessageId),
      steerTurn: (threadId, turnId, text, clientUserMessageId) => this.steerTurn(threadId, turnId, text, clientUserMessageId),
      interruptTurn: (threadId, turnId) => this.interruptTurn(threadId, turnId),
      interruptPendingSubmission: (threadId) => this.interruptPendingSubmission(threadId),
      waitForTurn: (turnId) => this.waitForTurn(turnId),
    };
    this.on("error", () => undefined);
  }

  get session(): CodexTuiSessionInfo | null { return this.attached ? { ...this.attached } : null; }

  async beginLaunch(options: {
    cwd: string;
    launch: CodexTuiLaunch;
    hookScriptPath: string;
    bypassHookTrust?: boolean;
  }): Promise<AgentProcessLaunch> {
    this.reset("Codex session is restarting.");
    this.launchReady = deferred<CodexTuiSessionInfo>();
    await fs.access(options.hookScriptPath);
    return buildCodexTuiLaunch(options.cwd, options.launch, options.hookScriptPath, process.execPath, options.bypassHookTrust);
  }

  async waitForSession(timeoutMs = 30_000, startupError?: () => string | null): Promise<CodexTuiSessionInfo> {
    const ready = this.launchReady;
    if (!ready) throw new Error("CODEX_TUI_LAUNCH_NOT_PREPARED");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ready.settled) return ready.promise;
      const error = startupError?.();
      if (error) throw new Error(error);
      const result = await Promise.race([
        ready.promise.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(150, Math.max(1, deadline - Date.now())))),
      ]);
      if (result) return result.value;
    }
    throw new Error("CODEX_HOOK_TRUST_REQUIRED_OR_SESSION_START_TIMEOUT");
  }

  async handleHook(payload: any): Promise<void> {
    const eventName = String(payload?.hook_event_name ?? payload?.hookEventName ?? "");
    const sessionId = String(payload?.session_id ?? payload?.sessionId ?? this.attached?.sessionId ?? "");
    const transcriptPath = stringOrNull(payload?.transcript_path ?? payload?.transcriptPath);
    if (this.attached && transcriptPath) this.attached.transcriptPath = transcriptPath;

    if (eventName === "SessionStart") {
      if (!sessionId) throw new Error("CODEX_SESSION_ID_MISSING");
      if (this.attached?.sessionId && this.attached.sessionId !== sessionId) {
        const message = `Codex switched from session ${this.attached.sessionId} to ${sessionId}.`;
        if (this.submission) this.rejectSubmission(this.submission, new Error(message));
        for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
      }
      const info: CodexTuiSessionInfo = {
        sessionId,
        cwd: String(payload?.cwd ?? this.attached?.cwd ?? ""),
        transcriptPath,
        source: stringOrNull(payload?.source),
      };
      this.attached = info;
      this.sessionCursor = await transcriptCursor(transcriptPath);
      this.launchReady?.resolve(info);
      this.emit("session", info);
      return;
    }
    if (!sessionId || (this.attached && sessionId !== this.attached.sessionId)) return;
    if (eventName === "UserPromptSubmit") {
      this.acceptPrompt(payload, sessionId);
      return;
    }
    if (eventName === "Stop") {
      this.finishTurn(payload, sessionId, "completed");
      return;
    }
    if (eventName === "PostCompact") {
      this.emit("compacted", { sessionId, transcriptPath: this.attached?.transcriptPath ?? null });
      return;
    }
    if (eventName === "SessionEnd") {
      this.observeTerminalExit("Codex session ended before a final answer was produced.");
      this.emit("sessionEnd", { sessionId, reason: payload?.reason ?? null });
    }
  }

  observeTerminalInput(data: string): void {
    if ((data !== "\x03" && data !== "\x1b" && data !== "\x1b\x1b") || !this.turns.size) return;
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", "Codex turn was interrupted in the terminal.");
  }

  observeTerminalExit(message = "Codex TUI exited before the turn produced a final answer."): void {
    if (this.submission) this.rejectSubmission(this.submission, new Error(message));
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
    if (this.launchReady && !this.launchReady.settled) {
      this.launchReady.reject(new Error(message));
      void this.launchReady.promise.catch(() => undefined);
    }
    this.attached = null;
  }

  async stop(): Promise<void> { this.reset("Codex session was closed."); }

  private async startTurn(threadId: string, text: string, clientUserMessageId: string): Promise<{ turnId: string }> {
    this.assertAttached(threadId);
    if (this.activeTurnIds(threadId).length) throw new Error("CODEX_SESSION_BUSY");
    const submission = await this.reserveSubmission("turn", text, clientUserMessageId, null);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(submission, new Error("CODEX_TERMINAL_NOT_RUNNING"));
    }
    return { turnId: await submission.accepted.promise };
  }

  private async steerTurn(threadId: string, turnId: string, text: string, clientUserMessageId: string): Promise<void> {
    this.assertAttached(threadId);
    if (!this.turns.has(turnId)) throw new Error("CODEX_TURN_NOT_ACTIVE");
    const submission = await this.reserveSubmission("steer", text, clientUserMessageId, turnId);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(submission, new Error("CODEX_TERMINAL_NOT_RUNNING"));
    }
    await submission.accepted.promise;
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.assertAttached(threadId);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    // Codex 0.147.0 uses Escape to interrupt a live turn. Keep this in the
    // provider adapter so a future CLI change does not alter other agents.
    this.pty.write(this.tabId, "\x1b");
    this.completeTurn(turn, "interrupted", "", "Codex turn was interrupted before a final answer was produced.");
  }

  private async interruptPendingSubmission(threadId: string): Promise<boolean> {
    this.assertAttached(threadId);
    const submission = this.submission;
    if (!submission) {
      if (!this.reservationInFlight) return false;
      this.submissionReservation += 1;
      this.reservationInFlight = false;
      return true;
    }
    const evidence = await inspectCodexSubmission(this.submissionCursor(submission), submission.prompt, threadId);
    if (evidence.state === "accepted") {
      this.acceptRecoveredSubmission(submission, evidence);
      const turnId = submission.kind === "steer" ? submission.logicalTurnId : evidence.turnId;
      if (turnId) await this.interruptTurn(threadId, turnId);
      return true;
    }
    this.pty.write(this.tabId, "\x1b");
    this.rejectSubmission(submission, new Error("PROMPT_SUBMISSION_INTERRUPTED"));
    return true;
  }

  private async waitForTurn(turnId: string): Promise<{ turn: any; items: any[] }> {
    const completed = this.completed.get(turnId);
    if (completed) return completed;
    while (true) {
      const active = this.turns.get(turnId);
      if (!active) throw new Error(`CODEX_TURN_NOT_FOUND:${turnId}`);
      const result = await Promise.race([
        active.completion.promise.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (result) return result.value;
      const recovered = await reconcileCodexTurn(active.recordCursor, active.threadId, active.turnId, active.prompt);
      if (recovered) this.completeTurn(active, recovered.status, recovered.answer, "Codex turn ended without a completion hook.", recovered.completedAt);
    }
  }

  private activeTurnIds(threadId: string): string[] {
    return [...this.turns.values()].filter((turn) => turn.threadId === threadId).map((turn) => turn.turnId);
  }

  private async waitForThreadIdle(threadId: string, timeoutMs = 24 * 60 * 60 * 1000): Promise<void> {
    if (!this.activeTurnIds(threadId).length) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.activeTurnIds(threadId).length) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(500, Math.max(1, deadline - Date.now())));
        const manager = this;
        function done() { clearTimeout(timer); manager.removeListener("turnCompleted", done); resolve(); }
        this.once("turnCompleted", done);
      });
    }
    throw new Error("THREAD_IDLE_TIMEOUT");
  }

  private acceptPrompt(payload: any, sessionId: string): void {
    const prompt = String(payload?.prompt ?? payload?.user_prompt ?? "");
    const hookTurnId = String(payload?.turn_id ?? payload?.turnId ?? "") || randomUUID();
    const pending = this.submission;
    if (pending && !prompt.trim()) {
      this.emit("submissionAmbiguous", { threadId: sessionId, reason: "CODEX_HOOK_PROMPT_MISSING" });
      return;
    }
    const submission = pending && sameSubmittedPrompt(pending.prompt, prompt)
      ? this.takeSubmission(pending)
      : null;
    if (submission?.kind === "steer") {
      submission.accepted.resolve(submission.logicalTurnId!);
      this.emit("turnSteered", { threadId: sessionId, turnId: submission.logicalTurnId, prompt: submission.prompt, origin: "queue" });
      return;
    }
    const active = [...this.turns.values()].find((candidate) => candidate.threadId === sessionId);
    if (submission && active) {
      submission.accepted.resolve(active.turnId);
      this.emit("turnSteered", { threadId: sessionId, turnId: active.turnId, prompt: submission.prompt, origin: "queue" });
      return;
    }
    if (!submission && active) {
      this.emit("turnSteered", { threadId: sessionId, turnId: active.turnId, prompt, origin: "manual" });
      return;
    }
    this.createTurn(hookTurnId, sessionId, prompt || submission?.prompt || "[non-text input]", submission);
  }

  private finishTurn(payload: any, sessionId: string, status: "completed" | "failed"): void {
    const requestedId = String(payload?.turn_id ?? payload?.turnId ?? "");
    const turn = (requestedId ? this.turns.get(requestedId) : null)
      ?? [...this.turns.values()].find((candidate) => candidate.threadId === sessionId);
    if (!turn) return;
    const answer = String(payload?.last_assistant_message ?? payload?.lastAssistantMessage ?? "");
    const error = String(payload?.error ?? payload?.message ?? "Codex failed before a final answer was produced.");
    this.completeTurn(turn, status, answer, error);
  }

  private completeTurn(
    turn: TurnState,
    status: "completed" | "failed" | "interrupted",
    answer: string,
    errorMessage: string,
    recoveredCompletedAt?: string | null,
  ): void {
    if (!this.turns.delete(turn.turnId)) return;
    const completedAt = recoveredCompletedAt ?? new Date().toISOString();
    const items: any[] = [{
      type: "userMessage",
      text: turn.prompt,
      ...(turn.clientUserMessageId ? { clientId: turn.clientUserMessageId } : {}),
    }];
    if (answer) items.push({ type: "agentMessage", phase: status === "completed" ? "final_answer" : "partial_answer", text: answer });
    const result = {
      turn: {
        id: turn.turnId,
        status,
        startedAt: turn.startedAt,
        completedAt,
        ...(status === "completed" ? {} : { error: { message: errorMessage } }),
      },
      items,
    };
    this.completed.set(turn.turnId, result);
    while (this.completed.size > COMPLETED_CACHE_LIMIT) this.completed.delete(this.completed.keys().next().value!);
    turn.completion.resolve(result);
    this.emit("turnCompleted", { threadId: turn.threadId, turnId: turn.turnId, ...result, origin: turn.origin });
    void this.refreshSessionCursor();
  }

  private async reserveSubmission(kind: Submission["kind"], prompt: string, clientUserMessageId: string, logicalTurnId: string | null): Promise<Submission> {
    if (this.submission || this.reservationInFlight) throw new Error("CODEX_PROMPT_SUBMISSION_IN_FLIGHT");
    const attached = this.attached;
    const reservation = ++this.submissionReservation;
    this.reservationInFlight = true;
    try {
      const accepted = deferred<string>();
      const recordCursor = await transcriptCursor(attached?.transcriptPath);
      if (reservation !== this.submissionReservation) throw new Error("PROMPT_SUBMISSION_INTERRUPTED");
      if (this.attached !== attached) throw new Error("SESSION_NOT_READY");
      let submission!: Submission;
      submission = { kind, prompt, clientUserMessageId, logicalTurnId, recordCursor, accepted, timers: null as unknown as SubmitTimers };
      submission.timers = scheduleSubmitRecovery({
        inspect: () => inspectCodexSubmission(this.submissionCursor(submission), prompt, this.attached?.sessionId ?? ""),
        resend: () => { this.pty.submitEnter(this.tabId); },
        accept: (evidence) => this.acceptRecoveredSubmission(submission, evidence),
        unconfirmed: (evidence) => this.emit("submissionUnconfirmed", { threadId: this.attached?.sessionId, prompt, reason: evidence.reason ?? null }),
      });
      this.submission = submission;
      return submission;
    } finally {
      if (reservation === this.submissionReservation) this.reservationInFlight = false;
    }
  }

  private rejectSubmission(submission: Submission, error: Error): void {
    clearSubmitTimers(submission.timers);
    if (this.submission === submission) this.submission = null;
    submission.accepted.reject(error);
  }

  private takeSubmission(submission: Submission): Submission {
    clearSubmitTimers(submission.timers);
    if (this.submission === submission) this.submission = null;
    return submission;
  }

  private submissionCursor(submission: Submission): TranscriptCursor {
    return submission.recordCursor.path
      ? submission.recordCursor
      : { path: this.attached?.transcriptPath ?? null, offset: submission.recordCursor.offset };
  }

  private acceptRecoveredSubmission(submission: Submission, evidence: Extract<SubmitEvidence, { state: "accepted" }>): void {
    if (this.submission !== submission) return;
    this.takeSubmission(submission);
    if (submission.kind === "steer") {
      submission.accepted.resolve(submission.logicalTurnId!);
      return;
    }
    const active = [...this.turns.values()].find((turn) => turn.threadId === (this.attached?.sessionId ?? ""));
    if (active) {
      submission.accepted.resolve(active.turnId);
      this.emit("turnSteered", { threadId: active.threadId, turnId: active.turnId, prompt: submission.prompt, origin: "queue" });
      return;
    }
    const turn = this.createTurn(evidence.turnId, this.attached?.sessionId ?? "", submission.prompt, submission);
    if (evidence.turn?.status && evidence.turn.status !== "running") {
      const answer = answerFromItems(evidence.items ?? evidence.turn.items ?? []);
      this.completeTurn(turn, evidence.turn.status === "completed" ? "completed" : "interrupted", answer, "Codex turn ended before its hook was observed.", evidence.turn.completedAt ?? null);
    }
  }

  private createTurn(turnId: string, threadId: string, prompt: string, submission: Submission | null): TurnState {
    const turn: TurnState = {
      turnId,
      threadId,
      prompt,
      clientUserMessageId: submission?.clientUserMessageId ?? null,
      origin: submission ? "queue" : "manual",
      startedAt: new Date().toISOString(),
      // SessionStart snapshots the rollout tail, so a manual prompt after a
      // long resume never makes the low-frequency completion check rescan the
      // whole conversation. Queue submissions keep their own pre-write cursor.
      recordCursor: submission ? this.submissionCursor(submission) : { ...this.sessionCursor },
      completion: deferred(),
    };
    this.turns.set(turnId, turn);
    submission?.accepted.resolve(turnId);
    this.emit("turnStarted", { threadId, turnId, prompt, origin: turn.origin });
    return turn;
  }

  private assertAttached(threadId: string): void {
    if (!this.attached || this.attached.sessionId !== threadId) throw new Error("SESSION_NOT_READY");
  }

  private async refreshSessionCursor(): Promise<void> {
    const session = this.attached;
    if (!session?.transcriptPath) return;
    const next = await transcriptCursor(session.transcriptPath);
    if (this.attached === session) this.sessionCursor = next;
  }

  private reset(message: string): void {
    this.submissionReservation += 1;
    this.reservationInFlight = false;
    if (this.submission) this.rejectSubmission(this.submission, new Error(message));
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
    this.launchReady?.reject(new Error(message));
    void this.launchReady?.promise.catch(() => undefined);
    this.launchReady = null;
    this.attached = null;
    this.sessionCursor = { path: null, offset: 0 };
  }
}

export class CodexTuiPool extends EventEmitter {
  private readonly managers = new Map<string, CodexTuiManager>();

  constructor(private readonly pty: PtyManager) { super(); }

  get(tabId: string): CodexTuiManager {
    let manager = this.managers.get(tabId);
    if (manager) return manager;
    manager = new CodexTuiManager(tabId, this.pty);
    this.managers.set(tabId, manager);
    this.emit("created", { tabId, manager });
    return manager;
  }

  existing(tabId: string): CodexTuiManager | null { return this.managers.get(tabId) ?? null; }

  async stop(tabId: string): Promise<void> {
    const manager = this.managers.get(tabId);
    if (!manager) return;
    await manager.stop();
    this.managers.delete(tabId);
    this.emit("removed", { tabId });
  }

  async stopAll(): Promise<void> { await Promise.all([...this.managers.keys()].map((tabId) => this.stop(tabId))); }
}

export function buildCodexHookOverride(hookScriptPath: string, nodePath = process.execPath): string {
  const events = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostCompact"];
  const fields = events.map((event) => {
    const command = `${quoteHookArg(nodePath)} ${quoteHookArg(hookScriptPath)} ${event}`;
    return `${event}=[{hooks=[{type="command",command=${tomlString(command)},timeout=10}]}]`;
  });
  return `hooks={${fields.join(",")}}`;
}

export function buildCodexTuiLaunch(
  cwd: string,
  launch: CodexTuiLaunch,
  hookScriptPath: string,
  nodePath = process.execPath,
  bypassHookTrust = false,
): AgentProcessLaunch {
  const args = launch.mode === "resume" ? ["resume", launch.sessionId] : [];
  args.push("--no-alt-screen", "-C", cwd, "-c", "check_for_update_on_startup=false", "-c", buildCodexHookOverride(hookScriptPath, nodePath));
  if (bypassHookTrust) args.push("--dangerously-bypass-hook-trust");
  return { executable: "codex", args };
}

/** Resolve the npm `.cmd` shim to Node + codex.js before the exact-argv launch. */
export async function resolveCodexTuiLaunch(launch: AgentProcessLaunch): Promise<AgentProcessLaunch> {
  const configured = String(process.env.CODEX_PROMPTOR_CODEX_EXECUTABLE ?? "").trim();
  if (configured) return { ...launch, executable: configured };
  if (process.platform !== "win32") return launch;
  try {
    const result = await execFileAsync("where.exe", ["codex"], { windowsHide: true });
    const candidates = String(result.stdout).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const executable = candidates.find((value) => /\.exe$/i.test(value));
    if (executable) return { ...launch, executable };
    const shim = candidates.find((value) => /\.cmd$/i.test(value));
    if (shim) {
      const cli = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
      await fs.access(cli);
      return { executable: process.execPath, args: [cli, ...launch.args] };
    }
  } catch { /* report the stable adapter error below */ }
  throw new Error("CODEX_NATIVE_EXECUTABLE_NOT_FOUND");
}

export function codexHookStartupError(output: string): string | null {
  const plain = output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ");
  return /(?:hook[^\r\n]{0,80}(?:not trusted|untrusted|trust required)|(?:not trusted|untrusted)[^\r\n]{0,80}hook)/i.test(plain)
    ? "CODEX_HOOK_TRUST_REQUIRED"
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function quoteHookArg(value: string): string {
  return /\s|["']/u.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

function tomlString(value: string): string { return JSON.stringify(value); }

function answerFromItems(items: any[]): string {
  const agents = items.filter((item) => String(item?.type ?? "").toLowerCase() === "agentmessage");
  for (let index = agents.length - 1; index >= 0; index -= 1) {
    const item = agents[index];
    if (String(item?.phase ?? "").toLowerCase() === "final_answer") return String(item?.text ?? "");
  }
  return String(agents.at(-1)?.text ?? "");
}
