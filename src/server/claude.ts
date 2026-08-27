import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { CLAUDE_EXIT_MARKER, type PtyManager, type TerminalTheme } from "./pty.js";
import type { QueueBinding, QueueRpc } from "./queue.js";
import { clearSubmitTimers, scheduleSubmitRecovery, type SubmitTimers } from "./prompt-submit.js";

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
  completion: Deferred<{ turn: any; items: any[] }>;
};

type Submission = {
  kind: "turn" | "steer";
  prompt: string;
  clientUserMessageId: string;
  logicalTurnId: string | null;
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
  private readonly submissions: Submission[] = [];

  constructor(readonly tabId: string, private readonly pty: PtyManager) {
    super();
    this.rpc = {
      activeTurnIds: (threadId) => this.activeTurnIds(threadId),
      waitForThreadIdle: (threadId, timeoutMs) => this.waitForThreadIdle(threadId, timeoutMs),
      startTurn: (threadId, text, clientUserMessageId) => this.startTurn(threadId, text, clientUserMessageId),
      steerTurn: (threadId, turnId, text, clientUserMessageId) => this.steerTurn(threadId, turnId, text, clientUserMessageId),
      interruptTurn: (threadId, turnId) => this.interruptTurn(threadId, turnId),
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
        for (const submission of [...this.submissions]) this.rejectSubmission(submission, new Error(message));
        for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
      }
      const info: ClaudeSessionInfo = {
        sessionId,
        cwd: String(payload?.cwd ?? this.attached?.cwd ?? ""),
        transcriptPath,
        source: stringOrNull(payload?.source),
      };
      this.attached = info;
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
    for (const submission of [...this.submissions]) this.rejectSubmission(submission, new Error(message));
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
    const accepted = this.reserveSubmission("turn", text, clientUserMessageId, null);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(accepted, new Error("CLAUDE_TERMINAL_NOT_RUNNING"));
      throw new Error("CLAUDE_TERMINAL_NOT_RUNNING");
    }
    return { turnId: await accepted.accepted.promise };
  }

  private async steerTurn(threadId: string, turnId: string, text: string, clientUserMessageId: string): Promise<void> {
    this.assertAttached(threadId);
    if (!this.turns.has(turnId)) throw new Error("CLAUDE_TURN_NOT_ACTIVE");
    const accepted = this.reserveSubmission("steer", text, clientUserMessageId, turnId);
    if (!this.pty.submitPrompt(this.tabId, text)) {
      this.rejectSubmission(accepted, new Error("CLAUDE_TERMINAL_NOT_RUNNING"));
      throw new Error("CLAUDE_TERMINAL_NOT_RUNNING");
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

  private waitForTurn(turnId: string): Promise<{ turn: any; items: any[] }> {
    const completed = this.completed.get(turnId);
    if (completed) return Promise.resolve(completed);
    const active = this.turns.get(turnId);
    if (!active) return Promise.reject(new Error(`CLAUDE_TURN_NOT_FOUND:${turnId}`));
    return active.completion.promise;
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
    const submissionIndex = this.submissions.findIndex((candidate) => samePrompt(candidate.prompt, prompt));
    // A manual terminal prompt can race an injected queue prompt. Never claim
    // a non-empty, mismatched hook as the queued submission; only fall back by
    // order for older hook payloads that omit the prompt text entirely.
    const index = submissionIndex >= 0 ? submissionIndex : (!prompt.trim() && this.submissions.length ? 0 : -1);
    const submission = index >= 0 ? this.submissions.splice(index, 1)[0] : null;
    if (submission) clearSubmitTimers(submission.timers);
    const hookPromptId = String(payload?.prompt_id ?? payload?.promptId ?? "") || randomUUID();
    if (submission?.kind === "steer") {
      submission.accepted.resolve(submission.logicalTurnId!);
      return;
    }
    // Claude accepts terminal follow-ups while an answer is active. They are
    // steering for that logical turn, not a second independently completing
    // turn; Stop will finalize the existing turn once.
    const active = [...this.turns.values()].find((candidate) => candidate.threadId === sessionId);
    if (!submission && active) {
      this.emit("turnSteered", { threadId: sessionId, turnId: active.turnId, prompt, origin: "manual" });
      return;
    }
    const turnId = hookPromptId;
    const turn: TurnState = {
      turnId,
      threadId: sessionId,
      prompt: prompt || submission?.prompt || "[non-text input]",
      clientUserMessageId: submission?.clientUserMessageId ?? null,
      origin: submission ? "queue" : "manual",
      startedAt: new Date().toISOString(),
      completion: deferred(),
    };
    this.turns.set(turnId, turn);
    submission?.accepted.resolve(turnId);
    this.emit("turnStarted", { threadId: sessionId, turnId, prompt: turn.prompt, origin: turn.origin });
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

  private completeTurn(turn: TurnState, status: "completed" | "failed" | "interrupted", answer: string, errorMessage: string): void {
    if (!this.turns.delete(turn.turnId)) return;
    const completedAt = new Date().toISOString();
    const items: any[] = [{
      type: "userMessage",
      text: turn.prompt,
      ...(turn.clientUserMessageId ? { clientId: turn.clientUserMessageId } : {}),
    }];
    if (status === "completed" && answer) items.push({ type: "agentMessage", phase: "final_answer", text: answer });
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
  }

  private reserveSubmission(kind: Submission["kind"], prompt: string, clientUserMessageId: string, logicalTurnId: string | null): Submission {
    const accepted = deferred<string>();
    const submission = {
      kind,
      prompt,
      clientUserMessageId,
      logicalTurnId,
      accepted,
      // The prompt text is already in the input box; a dropped Enter is what
      // stalls the turn, so retry that before failing the queued prompt.
      timers: scheduleSubmitRecovery(
        () => this.pty.submitEnter(this.tabId),
        () => this.rejectSubmission(submission, new Error("CLAUDE_PROMPT_SUBMIT_TIMEOUT")),
      ),
    } satisfies Submission;
    this.submissions.push(submission);
    return submission;
  }

  private rejectSubmission(submission: Submission, error: Error): void {
    clearSubmitTimers(submission.timers);
    const index = this.submissions.indexOf(submission);
    if (index >= 0) this.submissions.splice(index, 1);
    submission.accepted.reject(error);
  }

  private assertAttached(threadId: string): void {
    if (!this.attached || this.attached.sessionId !== threadId) throw new Error("SESSION_NOT_READY");
  }

  private reset(message: string): void {
    for (const submission of [...this.submissions]) this.rejectSubmission(submission, new Error(message));
    for (const turn of [...this.turns.values()]) this.completeTurn(turn, "interrupted", "", message);
    this.launchReady?.reject(new Error(message));
    // Avoid an unhandled rejection when a prepared launch is replaced before
    // the caller starts waiting for SessionStart.
    void this.launchReady?.promise.catch(() => undefined);
    this.launchReady = null;
    this.attached = null;
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

function samePrompt(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n").trim() === right.replace(/\r\n/g, "\n").trim();
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
