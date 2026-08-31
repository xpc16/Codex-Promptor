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

/**
 * A launch that ended with Codex still waiting for an answer on screen.
 *
 * The distinction matters to the caller: nothing is broken and nothing should
 * be torn down. The terminal has to stay up, still writable, still holding the
 * question -- killing it is what turned "answer this" into "cannot open".
 */
export const CODEX_STARTUP_QUESTION_UNANSWERED = "CODEX_STARTUP_QUESTION_UNANSWERED";

/** The question text, when a failure is one nobody answered. */
export function codexStartupQuestionFrom(message: string): string | null {
  const match = new RegExp(`${CODEX_STARTUP_QUESTION_UNANSWERED}:(.*)$`, "s").exec(message);
  return match ? match[1].trim() || "Codex 启动提问" : null;
}

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
    const { node, script } = await resolveHookCommandPaths(options.hookScriptPath, process.execPath);
    return buildCodexTuiLaunch(options.cwd, options.launch, script, node, options.bypassHookTrust);
  }

async waitForSession(
    timeoutMs = 30_000,
    startupError?: () => string | null,
    pendingQuestion?: () => string | null,
    questionTimeoutMs = 10 * 60_000,
  ): Promise<CodexTuiSessionInfo> {
    const ready = this.launchReady;
    if (!ready) throw new Error("CODEX_TUI_LAUNCH_NOT_PREPARED");
    let deadline = Date.now() + timeoutMs;
    const latest = Date.now() + Math.max(timeoutMs, questionTimeoutMs);
    let asked: string | null = null;
    while (Date.now() < deadline) {
      if (ready.settled) return ready.promise;
      const error = startupError?.();
      if (error) throw new Error(error);
      // Codex is waiting for an answer, not stuck. Counting down through the
      // question and then killing the terminal would take away the very prompt
      // the reader has to answer, so the clock stops while it is on screen.
      const question = pendingQuestion?.();
      if (question) {
        asked = question;
        deadline = Math.min(latest, Date.now() + questionTimeoutMs);
      }
      const result = await Promise.race([
        ready.promise.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(150, Math.max(1, deadline - Date.now())))),
      ]);
      if (result) return result.value;
    }
    throw new Error(asked ? `${CODEX_STARTUP_QUESTION_UNANSWERED}:${asked}` : "CODEX_HOOK_TRUST_REQUIRED_OR_SESSION_START_TIMEOUT");
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

/**
 * A path Codex's hook runner can actually execute.
 *
 * Codex splits a hook command on whitespace and does not honour quotes.
 * Measured on 0.147.0: the same executable runs when written bare and reports
 * `hook: SessionStart Failed` when wrapped in quotes, because the quote
 * characters become part of the program name. So the command may contain no
 * whitespace anywhere, and quoting cannot rescue a path that does. On Windows
 * the 8.3 short path is a space-free alias for the same file, which is what
 * makes `C:\Program Files\nodejs\node.exe` expressible at all.
 */
export async function spaceFreePath(value: string): Promise<string | null> {
  if (!/\s/u.test(value)) return value;
  if (process.platform !== "win32") return null;
  try {
    const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFile('${value.replace(/'/g, "''")}').ShortPath`;
    const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const short = String(result.stdout).trim();
    return short && !/\s/u.test(short) ? short : null;
  } catch {
    // 8.3 name creation can be disabled per volume; there is no other alias.
    return null;
  }
}

/** Both halves of the hook command, in a form Codex can run. */
export async function resolveHookCommandPaths(hookScriptPath: string, nodePath = process.execPath): Promise<{ node: string; script: string }> {
  const [node, script] = await Promise.all([spaceFreePath(nodePath), spaceFreePath(hookScriptPath)]);
  // Better a named failure than a hook that is silently never runnable: without
  // it the only symptom is SessionStart never arriving, thirty seconds later.
  if (!node) throw new Error(`CODEX_HOOK_PATH_HAS_SPACES:${nodePath}`);
  if (!script) throw new Error(`CODEX_HOOK_PATH_HAS_SPACES:${hookScriptPath}`);
  return { node, script };
}

export function buildCodexHookOverride(hookScriptPath: string, nodePath = process.execPath): string {
  const events = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostCompact"];
  for (const value of [nodePath, hookScriptPath]) {
    if (/\s/u.test(value)) throw new Error(`CODEX_HOOK_PATH_HAS_SPACES:${value}`);
  }
  const fields = events.map((event) => {
    // Deliberately unquoted: see spaceFreePath. Both halves are whitespace-free
    // by the check above, so splitting on whitespace yields the right argv.
    const command = `${nodePath} ${hookScriptPath} ${event}`;
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

const QUESTION_OPTION = /^›\s*\d+[.)]\s+\S/u;
const QUESTION_HEADING_LINES = 8;

/**
 * The question Codex is waiting on before any session exists, or null.
 *
 * More than one screen can stop a launch here: the working-directory trust
 * prompt, then the hooks review (tui/src/startup_hooks_review.rs), and a later
 * Codex may add others. From this side every one of them looks the same as a
 * hang -- no SessionStart, no error, just a screen -- so the wait used to count
 * down through the question and then tear down the terminal holding it, taking
 * away the prompt the reader was supposed to answer.
 *
 * They share a shape rather than a wording: a numbered list whose current row
 * is marked with U+203A, under a heading, above a "press enter" footer.
 * Matching the shape parks the clock for a question this code has never seen.
 */
export function codexStartupQuestion(output: string): string | null {
  const lines = stripTerminalControls(output).split(/\r?\n/).map((line) => line.trim());
  let selected = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (QUESTION_OPTION.test(lines[index])) { selected = index; break; }
  }
  if (selected < 0) return null;
  if (!lines.slice(selected).some((line) => /press enter/i.test(line))) return null;
  // The heading sits a few lines above the options, past the wrapped detail
  // text. Keep the topmost line of that run: it is the question itself, where
  // the lines below it only qualify the answer.
  let heading: string | null = null;
  for (let index = selected - 1; index >= 0 && index > selected - QUESTION_HEADING_LINES; index -= 1) {
    const line = lines[index];
    // ">" prefixes Codex's own working-directory banner, not the question.
    if (!line || line.startsWith(">") || /^\d+[.)]\s/u.test(line) || QUESTION_OPTION.test(line)) continue;
    heading = line;
  }
  return heading;
}

export function codexHookStartupError(output: string): string | null {
  const plain = stripTerminalControls(output);
  return /(?:hook[^\r\n]{0,80}(?:not trusted|untrusted|trust required)|(?:not trusted|untrusted)[^\r\n]{0,80}hook)/i.test(plain)
    ? "CODEX_HOOK_TRUST_REQUIRED"
    : null;
}

/**
 * Turns the two hook-setup failures into something the reader can act on.
 *
 * Neither is a broken conversation: one is Codex asking a question in the
 * terminal below, the other is a path this machine cannot express in a hook
 * command. Reporting the raw code leaves the reader with nothing to do.
 */
export function codexHookFailureText(message: string): string | null {
  const question = codexStartupQuestionFrom(message);
  if (question) {
    return `Codex 正在下方终端里等你回答：「${question}」。用方向键选择后回车（钩子信任请选 Trust all and continue），答案会被 Codex 记住；随后点「重新打开」即可连上。`;
  }
  if (message.includes("CODEX_HOOK_TRUST_REQUIRED")) {
    return "Codex 正在终端里请求信任本应用的钩子。请在下方终端选择「Trust all and continue」，然后重新打开该对话。";
  }
  const spaces = /CODEX_HOOK_PATH_HAS_SPACES:(.*)$/.exec(message);
  if (spaces) {
    return `钩子命令里的路径含空格，而 Codex 会按空格拆分命令且不识别引号：${spaces[1].trim()}。请把 Node 或本应用安装到不含空格的路径，或启用该盘符的 8.3 短路径。`;
  }
  if (message.includes("SESSION_START_TIMEOUT")) {
    return "Codex 启动后一直没有回报 SessionStart 钩子。若终端里有信任提示请先同意；否则用 npm run check:codex 确认钩子是否可用。";
  }
  return null;
}

function stripTerminalControls(output: string): string {
  return output
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ");
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
