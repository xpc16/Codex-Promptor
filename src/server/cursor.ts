import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CURSOR_EXIT_MARKER, type PtyManager, type TerminalTheme } from "./pty.js";
import type { QueueBinding, QueueRpc } from "./queue.js";
import { clearSubmitTimers, sameSubmittedPrompt, scheduleSubmitRecovery, type SubmitEvidence, type SubmitTimers } from "./prompt-submit.js";
import { inspectCursorSubmission, reconcileCursorTurn, transcriptCursor, type TranscriptCursor } from "./transcript-reconciliation.js";
import { writeFileAtomicWithRetry } from "./storage.js";

const execFileAsync = promisify(execFile);
const COMPLETED_CACHE_LIMIT = 100;

export type CursorLaunch = { mode: "new" } | { mode: "resume"; sessionId: string };
export type CursorSessionInfo = { sessionId: string; cwd: string; transcriptPath: string | null };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
};

type CursorTurn = {
  turnId: string;
  threadId: string;
  prompt: string;
  clientUserMessageId: string | null;
  origin: "queue" | "manual";
  startedAt: string;
  response: string;
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
    resolve: (result) => { if (!value.settled) { value.settled = true; resolvePromise(result); } },
    reject: (error) => { if (!value.settled) { value.settled = true; rejectPromise(error); } },
  };
  return value;
}

export class CursorCliManager extends EventEmitter implements QueueBinding {
  readonly rpc: QueueRpc;
  private launchReady: Deferred<CursorSessionInfo> | null = null;
  private attached: CursorSessionInfo | null = null;
  private readonly turns = new Map<string, CursorTurn>();
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

  get session(): CursorSessionInfo | null { return this.attached ? { ...this.attached } : null; }

  beginLaunch(cwd: string): void {
    this.reset("Cursor CLI session is restarting.");
    this.launchReady = deferred<CursorSessionInfo>();
    this.attached = { sessionId: "", cwd, transcriptPath: null };
  }

  async waitForSession(timeoutMs = 30_000, startupError?: () => string | null): Promise<CursorSessionInfo> {
    const ready = this.launchReady;
    if (!ready) throw new Error("CURSOR_LAUNCH_NOT_PREPARED");
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
    throw new Error("CURSOR_SESSION_START_TIMEOUT");
  }

  async handleHook(payload: any): Promise<Record<string, unknown>> {
    const event = String(payload?.hook_event_name ?? payload?.hookEventName ?? "");
    // conversation_id is the stable chat identity across generations. Some
    // lifecycle hooks also include a narrower session_id, so prefer the former
    // to keep sessionEnd associated with the attached conversation.
    const sessionId = String(payload?.conversation_id ?? payload?.session_id ?? payload?.sessionId ?? this.attached?.sessionId ?? "");
    const transcriptPath = stringOrNull(payload?.transcript_path ?? payload?.transcriptPath);
    if (this.attached && transcriptPath) this.attached.transcriptPath = transcriptPath;
    if (event === "sessionStart") {
      if (!sessionId) throw new Error("CURSOR_SESSION_ID_MISSING");
      if (this.attached?.sessionId && this.attached.sessionId !== sessionId) {
        const message = `Cursor CLI switched from conversation ${this.attached.sessionId} to ${sessionId}.`;
        if (this.submission) this.rejectSubmission(this.submission, new Error(message));
        for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
      }
      const info = {
        sessionId,
        cwd: String(payload?.workspace_roots?.[0] ?? this.attached?.cwd ?? ""),
        transcriptPath,
      };
      this.attached = info;
      this.sessionCursor = await transcriptCursor(transcriptPath);
      this.launchReady?.resolve(info);
      this.emit("session", info);
      return {};
    }
    if (!sessionId || (this.attached?.sessionId && sessionId !== this.attached.sessionId)) return {};
    if (event === "beforeSubmitPrompt") {
      this.acceptPrompt(payload, sessionId);
      return { continue: true };
    }
    if (event === "afterAgentResponse") {
      const turn = this.findTurn(payload, sessionId);
      if (turn) turn.response = String(payload?.text ?? turn.response);
      return {};
    }
    if (event === "stop") {
      const turn = this.findTurn(payload, sessionId);
      if (turn) {
        const rawStatus = String(payload?.status ?? "completed").toLowerCase();
        this.completeTurn(
          turn,
          rawStatus === "aborted" ? "interrupted" : rawStatus === "error" ? "failed" : "completed",
          turn.response,
          rawStatus === "aborted" ? "Cursor turn was aborted." : "Cursor turn failed before a final answer was produced.",
        );
      }
      return {};
    }
    if (event === "sessionEnd") {
      this.observeTerminalExit("Cursor CLI session ended before a final answer was produced.");
    }
    return {};
  }

  observeTerminalInput(data: string): void {
    if ((data !== "\x03" && data !== "\x1b") || !this.turns.size) return;
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", "Cursor turn was interrupted in the terminal.");
  }

  observeTerminalExit(message = "Cursor CLI TUI exited before the turn produced a final answer."): void {
    if (this.submission) this.rejectSubmission(this.submission, new Error(message));
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
    if (this.launchReady && !this.launchReady.settled) {
      this.launchReady.reject(new Error(message));
      void this.launchReady.promise.catch(() => undefined);
    }
    this.attached = null;
  }

  async stop(): Promise<void> { this.reset("Cursor CLI session was closed."); }

  private async startTurn(threadId: string, text: string, clientUserMessageId: string): Promise<{ turnId: string }> {
    this.assertAttached(threadId);
    if (this.activeTurnIds(threadId).length) throw new Error("CURSOR_SESSION_BUSY");
    const submission = await this.reserveSubmission("turn", text, clientUserMessageId, null);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(submission, new Error("CURSOR_TERMINAL_NOT_RUNNING"));
    }
    return { turnId: await submission.accepted.promise };
  }

  private async steerTurn(threadId: string, turnId: string, text: string, clientUserMessageId: string): Promise<void> {
    this.assertAttached(threadId);
    if (!this.turns.has(turnId)) throw new Error("CURSOR_TURN_NOT_ACTIVE");
    const submission = await this.reserveSubmission("steer", text, clientUserMessageId, turnId);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(submission, new Error("CURSOR_TERMINAL_NOT_RUNNING"));
    }
    await submission.accepted.promise;
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.assertAttached(threadId);
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.pty.write(this.tabId, "\x1b");
    this.completeTurn(turn, "interrupted", "", "Cursor turn was interrupted before a final answer was produced.");
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
    const evidence = await inspectCursorSubmission(this.submissionCursor(submission), submission.prompt);
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
      if (!active) throw new Error(`CURSOR_TURN_NOT_FOUND:${turnId}`);
      const result = await Promise.race([
        active.completion.promise.then((value) => ({ value })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
      ]);
      if (result) return result.value;
      const recovered = await reconcileCursorTurn(active.recordCursor, active.turnId);
      if (recovered) this.completeTurn(active, recovered.status, recovered.answer, "Cursor turn ended without a completion hook.", recovered.completedAt);
    }
  }

  private activeTurnIds(threadId: string): string[] {
    return [...this.turns.values()].filter((turn) => turn.threadId === threadId).map((turn) => turn.turnId);
  }

  private async waitForThreadIdle(threadId: string, timeoutMs = 24 * 60 * 60 * 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeTurnIds(threadId).length && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(500, Math.max(1, deadline - Date.now())));
        const manager = this;
        function done() { clearTimeout(timer); manager.removeListener("turnCompleted", done); resolve(); }
        this.once("turnCompleted", done);
      });
    }
    if (this.activeTurnIds(threadId).length) throw new Error("THREAD_IDLE_TIMEOUT");
  }

  private acceptPrompt(payload: any, sessionId: string): void {
    const prompt = String(payload?.prompt ?? "");
    const pending = this.submission;
    if (pending && !prompt.trim()) {
      this.emit("submissionAmbiguous", { threadId: sessionId, reason: "CURSOR_HOOK_PROMPT_MISSING" });
      return;
    }
    const submission = pending && sameSubmittedPrompt(pending.prompt, prompt)
      ? this.takeSubmission(pending)
      : null;
    if (submission?.kind === "steer") {
      submission.accepted.resolve(submission.logicalTurnId!);
      return;
    }
    const active = [...this.turns.values()].find((turn) => turn.threadId === sessionId);
    if (submission && active) {
      submission.accepted.resolve(active.turnId);
      this.emit("turnSteered", { threadId: sessionId, turnId: active.turnId, prompt: submission.prompt, origin: "queue" });
      return;
    }
    if (!submission && active) {
      this.emit("turnSteered", { threadId: sessionId, turnId: active.turnId, prompt, origin: "manual" });
      return;
    }
    const turnId = String(payload?.generation_id ?? payload?.generationId ?? "") || randomUUID();
    this.createTurn(turnId, sessionId, prompt || submission?.prompt || "[non-text input]", submission);
  }

  private findTurn(payload: any, sessionId: string): CursorTurn | null {
    const turnId = String(payload?.generation_id ?? payload?.generationId ?? "");
    return (turnId ? this.turns.get(turnId) : null)
      ?? [...this.turns.values()].find((turn) => turn.threadId === sessionId)
      ?? null;
  }

  private completeTurn(turn: CursorTurn, status: "completed" | "failed" | "interrupted", answer: string, errorMessage: string, recoveredCompletedAt?: string | null): void {
    if (!this.turns.delete(turn.turnId)) return;
    const completedAt = recoveredCompletedAt ?? new Date().toISOString();
    const items: any[] = [{ type: "userMessage", text: turn.prompt, ...(turn.clientUserMessageId ? { clientId: turn.clientUserMessageId } : {}) }];
    if (answer) items.push({ type: "agentMessage", phase: status === "completed" ? "final_answer" : "partial_answer", text: answer });
    const result = {
      turn: { id: turn.turnId, status, startedAt: turn.startedAt, completedAt, ...(status === "completed" ? {} : { error: { message: errorMessage } }) },
      items,
    };
    this.completed.set(turn.turnId, result);
    while (this.completed.size > COMPLETED_CACHE_LIMIT) this.completed.delete(this.completed.keys().next().value!);
    turn.completion.resolve(result);
    this.emit("turnCompleted", { threadId: turn.threadId, turnId: turn.turnId, ...result, origin: turn.origin });
    void this.refreshSessionCursor();
  }

  private async reserveSubmission(kind: Submission["kind"], prompt: string, clientUserMessageId: string, logicalTurnId: string | null): Promise<Submission> {
    if (this.submission || this.reservationInFlight) throw new Error("CURSOR_PROMPT_SUBMISSION_IN_FLIGHT");
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
        inspect: () => inspectCursorSubmission(this.submissionCursor(submission), prompt),
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
    this.createTurn(evidence.turnId, this.attached?.sessionId ?? "", submission.prompt, submission);
  }

  private createTurn(turnId: string, threadId: string, prompt: string, submission: Submission | null): void {
    const turn: CursorTurn = {
      turnId,
      threadId,
      prompt,
      clientUserMessageId: submission?.clientUserMessageId ?? null,
      origin: submission ? "queue" : "manual",
      startedAt: new Date().toISOString(),
      response: "",
      recordCursor: submission ? this.submissionCursor(submission) : { ...this.sessionCursor },
      completion: deferred(),
    };
    this.turns.set(turnId, turn);
    submission?.accepted.resolve(turnId);
    this.emit("turnStarted", { threadId, turnId, prompt, origin: turn.origin });
  }

  private assertAttached(threadId: string): void {
    if (!this.attached?.sessionId || this.attached.sessionId !== threadId) throw new Error("SESSION_NOT_READY");
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

export class CursorCliPool extends EventEmitter {
  private readonly managers = new Map<string, CursorCliManager>();
  constructor(private readonly pty: PtyManager) { super(); }
  get(tabId: string): CursorCliManager {
    let manager = this.managers.get(tabId);
    if (!manager) {
      manager = new CursorCliManager(tabId, this.pty);
      this.managers.set(tabId, manager);
      this.emit("created", { tabId, manager });
    }
    return manager;
  }
  existing(tabId: string): CursorCliManager | null { return this.managers.get(tabId) ?? null; }
  async stop(tabId: string): Promise<void> {
    const manager = this.managers.get(tabId);
    if (!manager) return;
    await manager.stop();
    this.managers.delete(tabId);
  }
  async stopAll(): Promise<void> { await Promise.all([...this.managers.keys()].map((tabId) => this.stop(tabId))); }
}

export async function ensureCursorHookBridge(rootDir: string, backupsDir: string): Promise<{ hooksPath: string; changed: boolean }> {
  const cursorRoot = path.resolve(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"));
  const hooksPath = path.join(cursorRoot, "hooks.json");
  const scriptPath = path.join(path.resolve(rootDir), "scripts", "cursor-hook.mjs");
  await fs.access(scriptPath);
  let existingText: string | null = null;
  let value: any = { version: 1, hooks: {} };
  try {
    existingText = await fs.readFile(hooksPath, "utf8");
    value = JSON.parse(existingText);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw new Error(`CURSOR_HOOKS_INVALID_JSON:${hooksPath}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`CURSOR_HOOKS_INVALID_JSON:${hooksPath}`);
  value.version = Number(value.version) || 1;
  if (value.hooks === undefined) value.hooks = {};
  else if (!value.hooks || typeof value.hooks !== "object" || Array.isArray(value.hooks)) throw new Error(`CURSOR_HOOKS_INVALID_JSON:${hooksPath}`);
  const events = ["sessionStart", "beforeSubmitPrompt", "afterAgentResponse", "stop", "sessionEnd"];
  let changed = false;
  for (const event of events) {
    const command = `${quoteCommandArg(process.execPath)} ${quoteCommandArg(scriptPath)} ${event}`;
    if (value.hooks[event] !== undefined && !Array.isArray(value.hooks[event])) throw new Error(`CURSOR_HOOKS_INVALID_JSON:${hooksPath}`);
    const entries = value.hooks[event] ?? [];
    if (!entries.some((entry: any) => entry?.command === command)) {
      entries.push({ command });
      changed = true;
    }
    value.hooks[event] = entries;
  }
  if (!changed) return { hooksPath, changed: false };
  await fs.mkdir(path.dirname(hooksPath), { recursive: true });
  await fs.mkdir(backupsDir, { recursive: true });
  if (existingText !== null) {
    const backup = path.join(backupsDir, `cursor-hooks-${Date.now()}.json`);
    await fs.writeFile(backup, existingText, "utf8");
  }
  await writeFileAtomicWithRetry(hooksPath, `${JSON.stringify(value, null, 2)}\n`);
  return { hooksPath, changed: true };
}

export function buildCursorCommand(cwd: string, launch: CursorLaunch, theme: TerminalTheme = "light", exitMarker = CURSOR_EXIT_MARKER): string {
  const foreground = theme === "light" ? "Black" : "Gray";
  const background = theme === "light" ? "White" : "Black";
  const ansi = theme === "light" ? "30;47" : "37;40";
  const resume = launch.mode === "resume" ? ` --resume=${quotePowerShellArg(launch.sessionId)}` : "";
  return `$env:NO_COLOR = "1"; Set-Location -LiteralPath ${quotePowerShellArg(cwd)}; $Host.UI.RawUI.ForegroundColor = "${foreground}"; $Host.UI.RawUI.BackgroundColor = "${background}"; $promptorEsc = [char]27; Write-Host -NoNewline "$promptorEsc[${ansi}m"; Clear-Host; & agent${resume}; $promptorCursorOk = $?; $promptorCursorExit = $LASTEXITCODE; if ($null -eq $promptorCursorExit) { if ($promptorCursorOk) { $promptorCursorExit = 0 } else { $promptorCursorExit = 1 } }; Write-Output "${exitMarker}$promptorCursorExit"`;
}

export async function probeCursorVersion(): Promise<{ available: boolean; version: string | null; error: string | null }> {
  try {
    const result = process.platform === "win32"
      ? await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "agent --version"], { windowsHide: true })
      : await execFileAsync("agent", ["--version"], { windowsHide: true });
    return { available: true, version: String(result.stdout).trim() || null, error: null };
  } catch (error) {
    return { available: false, version: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function stringOrNull(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function quotePowerShellArg(value: string): string { return /^[A-Za-z0-9_:/.-]+$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`; }
function quoteCommandArg(value: string): string { return `"${value.replace(/"/g, '\\"')}"`; }
