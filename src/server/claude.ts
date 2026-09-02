import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CLAUDE_EXIT_MARKER, type PtyManager, type TerminalTheme } from "./pty.js";
import type { QueueBinding, QueueRpc } from "./queue.js";
import {
  clearSubmitTimers,
  isSlashCommandPrompt,
  sameSubmittedPrompt,
  scheduleSubmitRecovery,
  SLASH_COMMAND_NO_TURN,
  type SubmitEvidence,
  type SubmitTimers,
} from "./prompt-submit.js";
import { inspectClaudeSubmission, reconcileClaudeTurn, transcriptCursor, type TranscriptCursor } from "./transcript-reconciliation.js";

const execFileAsync = promisify(execFile);
const COMPLETED_CACHE_LIMIT = 100;

export type ClaudeLaunch = { mode: "new" } | { mode: "resume"; sessionId: string };
export type ClaudeSessionInfo = {
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
  source: string | null;
};

export type ClaudeTurnCompletedEvent = {
  threadId: string;
  turnId: string;
  turn: any;
  items: any[];
  origin: "queue" | "manual";
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
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
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

export class ClaudeCodeManager extends EventEmitter implements QueueBinding {
  readonly rpc: QueueRpc;
  private launchReady: Deferred<ClaudeSessionInfo> | null = null;
  private attached: ClaudeSessionInfo | null = null;
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
    // Keep EventEmitter's special error event non-fatal for isolated tests.
    this.on("error", () => undefined);
  }

  get session(): ClaudeSessionInfo | null { return this.attached ? { ...this.attached } : null; }

  async beginLaunch(options: {
    cwd: string;
    launch: ClaudeLaunch;
    hookScriptPath: string;
    settingsPath: string;
    theme: TerminalTheme;
    exitMarker: string;
  }): Promise<string> {
    this.reset("Claude Code session is restarting.");
    this.launchReady = deferred<ClaudeSessionInfo>();
    await fs.access(options.hookScriptPath);
    await fs.mkdir(path.dirname(options.settingsPath), { recursive: true });
    await fs.writeFile(options.settingsPath, `${JSON.stringify(buildClaudeHookSettings(options.hookScriptPath), null, 2)}\n`, "utf8");
    return buildClaudeCommand(options.cwd, options.settingsPath, options.launch, options.theme, options.exitMarker);
  }

  async waitForSession(timeoutMs = 30_000, startupError?: () => string | null): Promise<ClaudeSessionInfo> {
    const ready = this.launchReady;
    if (!ready) throw new Error("CLAUDE_LAUNCH_NOT_PREPARED");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ready.settled) return ready.promise;
      const error = startupError?.();
      if (error) throw new Error(error);
      const remaining = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        ready.promise.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.min(150, remaining))),
      ]);
      if (result) return result.value;
    }
    throw new Error("CLAUDE_SESSION_START_TIMEOUT");
  }

  async handleHook(payload: any): Promise<void> {
    const eventName = String(payload?.hook_event_name ?? payload?.hookEventName ?? "");
    const sessionId = String(payload?.session_id ?? payload?.sessionId ?? this.attached?.sessionId ?? "");
    const transcriptPath = stringOrNull(payload?.transcript_path ?? payload?.transcriptPath);
    if (this.attached && transcriptPath) this.attached.transcriptPath = transcriptPath;
    if (eventName === "SessionStart") {
      if (!sessionId) throw new Error("CLAUDE_SESSION_ID_MISSING");
      if (this.attached?.sessionId && this.attached.sessionId !== sessionId) {
        const message = `Claude Code switched from session ${this.attached.sessionId} to ${sessionId}.`;
        if (this.submission) this.rejectSubmission(this.submission, new Error(message));
        for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
      }
      const info: ClaudeSessionInfo = {
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
    if (eventName === "StopFailure") {
      this.finishTurn(payload, sessionId, "failed");
      return;
    }
    if (eventName === "SessionEnd") {
      this.observeTerminalExit("Claude Code session ended before a final answer was produced.");
      this.emit("sessionEnd", { sessionId, reason: payload?.reason ?? null });
    }
  }

  observeTerminalInput(data: string): void {
    // Claude's Stop hook intentionally does not fire for user interrupts. Only
    // treat Escape/Ctrl-C as an interrupt while an agent turn is actually live.
    if ((data !== "\x03" && data !== "\x1b") || !this.turns.size) return;
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", "Claude Code turn was interrupted in the terminal.");
  }

  observeTerminalExit(message = "Claude Code TUI exited before the turn produced a final answer."): void {
    if (this.submission) this.rejectSubmission(this.submission, new Error(message));
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
    if (this.launchReady && !this.launchReady.settled) {
      this.launchReady.reject(new Error(message));
      void this.launchReady.promise.catch(() => undefined);
    }
    this.attached = null;
  }

  async stop(): Promise<void> {
    this.reset("Claude Code session was closed.");
  }

  private async startTurn(threadId: string, text: string, clientUserMessageId: string): Promise<{ turnId: string }> {
    this.assertAttached(threadId);
    if (this.activeTurnIds(threadId).length) throw new Error("CLAUDE_SESSION_BUSY");
    const accepted = await this.reserveSubmission("turn", text, clientUserMessageId, null);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(accepted, new Error("CLAUDE_TERMINAL_NOT_RUNNING"));
    }
    return { turnId: await accepted.accepted.promise };
  }

  private async steerTurn(threadId: string, turnId: string, text: string, clientUserMessageId: string): Promise<void> {
    this.assertAttached(threadId);
    if (!this.turns.has(turnId)) throw new Error("CLAUDE_TURN_NOT_ACTIVE");
    const accepted = await this.reserveSubmission("steer", text, clientUserMessageId, turnId);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(accepted, new Error("CLAUDE_TERMINAL_NOT_RUNNING"));
    }
    await accepted.accepted.promise;
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.assertAttached(threadId);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.pty.write(this.tabId, "\x1b");
    this.completeTurn(turn, "interrupted", "", "Claude Code turn was interrupted before a final answer was produced.");
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
    const evidence = await inspectClaudeSubmission(this.submissionCursor(submission), submission.prompt);
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
    while (true) {
      const completed = this.completed.get(turnId);
      if (completed) return completed;
      const active = this.turns.get(turnId);
      if (!active) throw new Error(`CLAUDE_TURN_NOT_FOUND:${turnId}`);
      const result = await Promise.race([
        active.completion.promise.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (result) return result.value;
      const recovered = await reconcileClaudeTurn(active.recordCursor, active.turnId, active.prompt);
      if (recovered) this.completeTurn(active, recovered.status, recovered.answer, "Claude Code turn ended without a completion hook.", recovered.completedAt);
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
    const pending = this.submission;
    // A manual terminal prompt can race an injected queue prompt. A hook that
    // omits or changes the text is ambiguous, so leave the slot pending for
    // transcript reconciliation instead of claiming it by arrival order.
    if (pending && !prompt.trim()) {
      this.emit("submissionAmbiguous", { threadId: sessionId, reason: "CLAUDE_HOOK_PROMPT_MISSING" });
      return;
    }
    const submission = pending && sameSubmittedPrompt(pending.prompt, prompt)
      ? this.takeSubmission(pending)
      : null;
    const hookPromptId = String(payload?.prompt_id ?? payload?.promptId ?? "") || randomUUID();
    if (submission?.kind === "steer") {
      submission.accepted.resolve(submission.logicalTurnId!);
      return;
    }
    // Claude accepts terminal follow-ups while an answer is active. They are
    // steering for that logical turn, not a second independently completing
    // turn; Stop will finalize the existing turn once.
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
    this.createTurn(hookPromptId, sessionId, prompt || submission?.prompt || "[non-text input]", submission);
  }

  private finishTurn(payload: any, sessionId: string, status: "completed" | "failed"): void {
    const requestedId = String(payload?.prompt_id ?? payload?.promptId ?? "");
    const turn = (requestedId ? this.turns.get(requestedId) : null)
      ?? [...this.turns.values()].find((candidate) => candidate.threadId === sessionId);
    if (!turn) return;
    const answer = String(payload?.last_assistant_message ?? payload?.lastAssistantMessage ?? "");
    const error = String(payload?.error ?? payload?.message ?? "Claude Code failed before a final answer was produced.");
    this.completeTurn(turn, status, answer, error);
  }

  private completeTurn(turn: TurnState, status: "completed" | "failed" | "interrupted", answer: string, errorMessage: string, recoveredCompletedAt?: string | null): void {
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
    const event: ClaudeTurnCompletedEvent = { threadId: turn.threadId, turnId: turn.turnId, ...result, origin: turn.origin };
    this.emit("turnCompleted", event);
    void this.refreshSessionCursor();
  }

  private async reserveSubmission(kind: Submission["kind"], prompt: string, clientUserMessageId: string, logicalTurnId: string | null): Promise<Submission> {
    if (this.submission || this.reservationInFlight) throw new Error("CLAUDE_PROMPT_SUBMISSION_IN_FLIGHT");
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
        inspect: () => inspectClaudeSubmission(this.submissionCursor(submission), prompt),
        resend: () => { this.pty.submitEnter(this.tabId); },
        accept: (evidence) => this.acceptRecoveredSubmission(submission, evidence),
        unconfirmed: (evidence) => {
          if (isSlashCommandPrompt(prompt)) {
            this.rejectSubmission(submission, new Error(SLASH_COMMAND_NO_TURN));
            return;
          }
          this.emit("submissionUnconfirmed", { threadId: this.attached?.sessionId, prompt, reason: evidence.reason ?? null });
        },
      }, isSlashCommandPrompt(prompt) ? [] : undefined);
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
    this.createTurn(evidence.turnId, this.attached?.sessionId ?? "", submission.prompt, submission);
  }

  private createTurn(turnId: string, threadId: string, prompt: string, submission: Submission | null): void {
    const turn: TurnState = {
      turnId,
      threadId,
      prompt,
      clientUserMessageId: submission?.clientUserMessageId ?? null,
      origin: submission ? "queue" : "manual",
      startedAt: new Date().toISOString(),
      recordCursor: submission ? this.submissionCursor(submission) : { ...this.sessionCursor },
      completion: deferred(),
    };
    this.turns.set(turnId, turn);
    submission?.accepted.resolve(turnId);
    this.emit("turnStarted", { threadId, turnId, prompt, origin: turn.origin });
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
    // Avoid an unhandled rejection when a prepared launch is replaced before
    // the caller starts waiting for SessionStart.
    void this.launchReady?.promise.catch(() => undefined);
    this.launchReady = null;
    this.attached = null;
    this.sessionCursor = { path: null, offset: 0 };
  }
}

export class ClaudeCodePool extends EventEmitter {
  private readonly managers = new Map<string, ClaudeCodeManager>();

  constructor(private readonly pty: PtyManager) { super(); }

  get(tabId: string): ClaudeCodeManager {
    let manager = this.managers.get(tabId);
    if (manager) return manager;
    manager = new ClaudeCodeManager(tabId, this.pty);
    this.managers.set(tabId, manager);
    this.emit("created", { tabId, manager });
    return manager;
  }

  existing(tabId: string): ClaudeCodeManager | null { return this.managers.get(tabId) ?? null; }

  async stop(tabId: string): Promise<void> {
    const manager = this.managers.get(tabId);
    if (!manager) return;
    await manager.stop();
    this.managers.delete(tabId);
    this.emit("removed", { tabId });
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managers.keys()].map((tabId) => this.stop(tabId)));
  }
}

export function buildClaudeHookSettings(hookScriptPath: string, nodePath = process.execPath): Record<string, unknown> {
  return {
    hooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]
      .map((event) => [event, [{
        matcher: "",
        hooks: [{ type: "command", command: `${quoteCommandArg(nodePath)} ${quoteCommandArg(hookScriptPath)} ${event}`, timeout: 10 }],
      }]])),
  };
}

export function buildClaudeCommand(cwd: string, settingsPath: string, launch: ClaudeLaunch, theme: TerminalTheme = "light", exitMarker = CLAUDE_EXIT_MARKER): string {
  const foreground = theme === "light" ? "Black" : "Gray";
  const background = theme === "light" ? "White" : "Black";
  const ansi = theme === "light" ? "30;47" : "37;40";
  const resume = launch.mode === "resume" ? ` --resume ${quotePowerShellArg(launch.sessionId)}` : "";
  const invocation = `& claude${resume} --settings ${quotePowerShellArg(settingsPath)}`;
  // Claude's fullscreen renderer uses the terminal alternate screen, whose
  // contents never enter xterm's native scrollback. Promptor is itself the
  // terminal emulator, so keep Claude on the classic main-screen renderer.
  return `$env:NO_COLOR = "1"; $env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1"; Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; $Host.UI.RawUI.ForegroundColor = "${foreground}"; $Host.UI.RawUI.BackgroundColor = "${background}"; $promptorEsc = [char]27; Write-Host -NoNewline "$promptorEsc[${ansi}m"; Clear-Host; ${invocation}; $promptorClaudeOk = $?; $promptorClaudeExit = $LASTEXITCODE; if ($null -eq $promptorClaudeExit) { if ($promptorClaudeOk) { $promptorClaudeExit = 0 } else { $promptorClaudeExit = 1 } }; Write-Output "${exitMarker}$promptorClaudeExit"`;
}

export async function probeClaudeVersion(): Promise<{ available: boolean; version: string | null; error: string | null }> {
  try {
    const result = process.platform === "win32"
      ? await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "claude --version"], { windowsHide: true })
      : await execFileAsync("claude", ["--version"], { windowsHide: true });
    return { available: true, version: String(result.stdout).trim() || null, error: null };
  } catch (error) {
    return { available: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function quotePowerShellArg(value: string): string {
  if (/^[A-Za-z0-9_:/.-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
