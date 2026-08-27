import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { terminateProcessTree } from "./codex.js";
import { TerminalScreenModel, type TerminalScreenSnapshot } from "./terminal-screen.js";

export type TerminalEvent =
  | { tabId: string; type: "output"; generation: string; startOffset: number; endOffset: number; dataBase64: string }
  | { tabId: string; type: "state"; state: "stopped" | "starting" | "running" | "exited" | "error"; exitCode?: number | null; message?: string };

export type TerminalTheme = "light" | "dark";
export type TerminalLaunch =
  | { mode: "new" }
  | { mode: "resume"; threadId: string };

type TerminalBuffer = { generation: string; buffer: Buffer; bufferStart: number; nextOffset: number; exitMarker?: string; agentLabel?: string };
type TerminalSize = { cols: number; rows: number };
type Session = TerminalBuffer & TerminalSize & { process: pty.IPty; agentExited: boolean; inputPrimed: boolean };

export type TerminalCursor = { generation?: string | null; nextOffset?: number | null; maxCatchUpBytes?: number | null };
export type TerminalSnapshot = {
  generation: string;
  startOffset: number;
  endOffset: number;
  reset: boolean;
  dataBase64: string;
  catchUpExceeded?: boolean;
};

export const CODEX_EXIT_MARKER = "__CODEX_PROMPTOR_EXIT__:";
export const CLAUDE_EXIT_MARKER = "__CLAUDE_PROMPTOR_EXIT__:";
export const CURSOR_EXIT_MARKER = "__CURSOR_PROMPTOR_EXIT__:";
// A plain terminal has no agent to outlive, so nothing ever writes this. It
// exists only because startCommand takes a marker; matching it would mean the
// shell announced its own death, which the PTY exit handler reports anyway.
export const SHELL_EXIT_MARKER = "__SHELL_PROMPTOR_NEVER_EXITS__:";
// Gap between the pasted prompt text and the Enter that submits it, so the
// agent TUI has a separate read to commit the paste before the key arrives.
const SUBMIT_ENTER_DELAY_MS = 90;
const MAX_BUFFER_BYTES = 1_000_000;

export class PtyManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly archives = new Map<string, TerminalBuffer>();
  private readonly requestedSizes = new Map<string, TerminalSize>();
  // A stopped PTY keeps its final screen until the tab is restarted/deleted so
  // a reconnecting projection client can still see the last meaningful frame.
  private readonly screens = new Map<string, TerminalScreenModel>();

  async start(tabId: string, cwd: string, remoteUrl: string, launch: TerminalLaunch, theme: TerminalTheme = "light"): Promise<void> {
    return this.startCommand(tabId, cwd, buildRemoteCodexCommand(remoteUrl, launch, cwd, theme), "Codex", CODEX_EXIT_MARKER, {}, theme);
  }
  /** A conversation that is only a PowerShell: no agent, no TUI, no App Server. */
  async startShell(tabId: string, cwd: string, theme: TerminalTheme = "light"): Promise<void> {
    return this.startCommand(tabId, cwd, buildShellCommand(cwd, theme), "PowerShell", SHELL_EXIT_MARKER, {}, theme);
  }

  async startCommand(
    tabId: string,
    cwd: string,
    command: string,
    agentLabel: string,
    exitMarker: string,
    envPatch: Record<string, string> = {},
    theme: TerminalTheme = "light",
  ): Promise<void> {
    await this.stop(tabId, false);
    this.archives.delete(tabId);
    this.screens.get(tabId)?.dispose();
    this.screens.delete(tabId);
    this.emitEvent({ tabId, type: "state", state: "starting" });
    try {
      const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
      // The browser can report its dimensions before a PTY exists. Starting at
      // that size avoids loading a long history at 80x12 and immediately
      // forcing Codex to repaint the entire history at a second size.
      const initialSize = this.requestedSizes.get(tabId) ?? { cols: 80, rows: 12 };
      const child = pty.spawn(shell, ["-NoLogo", "-NoExit", "-NoProfile"], {
        name: "xterm-256color",
        cols: initialSize.cols,
        rows: initialSize.rows,
        cwd,
        env: { ...process.env, ...envPatch } as Record<string, string>,
        useConpty: true,
      });
      const generation = randomUUID();
      const screen = new TerminalScreenModel({
        generation,
        cols: initialSize.cols,
        rows: initialSize.rows,
        theme,
        onResponse: (data) => {
          if (this.sessions.get(tabId)?.process !== child) return;
          try { child.write(data); } catch { /* process exited during a protocol reply */ }
        },
      });
      const session: Session = {
        process: child,
        generation,
        buffer: Buffer.alloc(0),
        bufferStart: 0,
        nextOffset: 0,
        cols: initialSize.cols,
        rows: initialSize.rows,
        agentExited: false,
        inputPrimed: false,
        exitMarker,
        agentLabel,
      };
      this.sessions.set(tabId, session);
      this.screens.set(tabId, screen);
      child.onData((data) => {
        // Queue parser work before publishing the output event. Projection
        // snapshots triggered by that event await the same queue barrier.
        const bytes = Buffer.from(data, "utf8");
        const startOffset = session.nextOffset;
        session.nextOffset += bytes.length;
        void screen.write(data, session.nextOffset);
        session.buffer = Buffer.concat([session.buffer, bytes]);
        if (session.buffer.length > MAX_BUFFER_BYTES) {
          const overflow = session.buffer.length - MAX_BUFFER_BYTES;
          session.buffer = session.buffer.subarray(overflow);
          session.bufferStart += overflow;
        }
        this.emitEvent({ tabId, type: "output", generation: session.generation, startOffset, endOffset: session.nextOffset, dataBase64: bytes.toString("base64") });
        const exitCode = parseAgentExitCode(session.buffer.toString("utf8"), exitMarker);
        if (exitCode !== null && !session.agentExited) {
          session.agentExited = true;
          this.emitEvent(exitCode === 0
            ? { tabId, type: "state", state: "exited", exitCode }
            : { tabId, type: "state", state: "error", exitCode, message: `${agentLabel} TUI exited with code ${exitCode}. PowerShell remains available.` });
        }
      });
      child.onExit(({ exitCode }) => {
        if (this.sessions.get(tabId)?.process !== child) return;
        this.sessions.delete(tabId);
        this.archives.set(tabId, copyBuffer(session));
        this.emitEvent({ tabId, type: "state", state: "exited", exitCode });
      });
      setTimeout(() => {
        if (this.sessions.get(tabId)?.process !== child) return;
        this.emitEvent({ tabId, type: "state", state: "running" });
        child.write(`${command}\r`);
      }, 180);
    } catch (error) {
      this.emitEvent({ tabId, type: "state", state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  write(tabId: string, data: string): void { this.sessions.get(tabId)?.process.write(data); }
  submitPrompt(tabId: string, text: string): boolean {
    const session = this.sessions.get(tabId);
    if (!session || session.agentExited) return false;
    // Bracketed paste keeps multiline prompts inside the native TUI input box.
    session.process.write(`\x1b[200~${text}\x1b[201~`);
    // The Enter deliberately goes out as a separate, later write. Claude and
    // Cursor commit a paste into their Ink input asynchronously, so a carriage
    // return arriving in the same read chunk can be handled against the still
    // empty input and dropped -- the prompt then sits in the box unsent, the
    // submit hook never fires, and the queue reports a submit timeout even
    // though the text is visibly there.
    setTimeout(() => this.submitEnter(tabId), SUBMIT_ENTER_DELAY_MS);
    return true;
  }
  /** Re-arms the Enter for a prompt whose text landed but was never submitted. */
  submitEnter(tabId: string): boolean {
    const session = this.sessions.get(tabId);
    if (!session || session.agentExited) return false;
    session.process.write("\r");
    return true;
  }
  primeCodexInput(tabId: string): boolean {
    const session = this.sessions.get(tabId);
    if (!session || session.agentExited || session.inputPrimed) return false;
    try {
      session.process.write(" ");
      session.inputPrimed = true;
      return true;
    } catch {
      return false;
    }
  }
  resize(tabId: string, cols: number, rows: number): boolean {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 5 || cols > 500 || rows > 200) return false;
    const previous = this.requestedSizes.get(tabId);
    const requestedChanged = !previous || previous.cols !== cols || previous.rows !== rows;
    this.requestedSizes.set(tabId, { cols, rows });
    const session = this.sessions.get(tabId);
    if (!session || (session.cols === cols && session.rows === rows)) return requestedChanged;
    try {
      // Enqueue the emulator resize before ConPTY can emit its resize repaint.
      // Any following onData callback is therefore parsed against the new grid.
      void this.screens.get(tabId)?.resize(cols, rows);
      session.process.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
      return true;
    } catch { /* process exited between lookup and resize */ }
    return requestedChanged;
  }
  forgetSize(tabId: string): void { this.requestedSizes.delete(tabId); }
  forget(tabId: string): void {
    this.requestedSizes.delete(tabId);
    this.archives.delete(tabId);
    this.screens.get(tabId)?.dispose();
    this.screens.delete(tabId);
  }
  setScreenResponder(tabId: string, enabled: boolean): void { this.screens.get(tabId)?.setResponderEnabled(enabled); }
  setScreenTheme(tabId: string, theme: TerminalTheme): void { this.screens.get(tabId)?.setTheme(theme); }
  async screenSnapshot(tabId: string, viewportRows = 20): Promise<TerminalScreenSnapshot | null> {
    const screen = this.screens.get(tabId);
    if (!screen) return null;
    try { return await screen.snapshot(viewportRows); }
    catch { return null; }
  }
  async stop(tabId: string, notify = true): Promise<void> {
    const session = this.sessions.get(tabId);
    if (session) {
      this.sessions.delete(tabId);
      this.archives.set(tabId, copyBuffer(session));
      await terminateProcessTree(session.process.pid).catch(() => {
        try { session.process.kill(); } catch { /* already exited */ }
      });
    }
    if (notify) this.emitEvent({ tabId, type: "state", state: "stopped", exitCode: null });
  }
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((tabId) => this.stop(tabId)));
    for (const screen of this.screens.values()) screen.dispose();
    this.screens.clear();
  }
  has(tabId: string): boolean { return this.sessions.has(tabId); }
  startupError(tabId: string): string | null {
    const source = this.sessions.get(tabId) ?? this.archives.get(tabId);
    if (!source) return null;
    return terminalStartupError(source.buffer.toString("utf8"), source.exitMarker, source.agentLabel);
  }
  snapshot(tabId: string, cursor: TerminalCursor = {}): TerminalSnapshot | null {
    const source = this.sessions.get(tabId) ?? this.archives.get(tabId);
    if (!source) return null;
    return sliceTerminalBuffer(source, cursor);
  }

  private emitEvent(event: TerminalEvent): void { this.emit("event", event); }
}

export function sliceTerminalBuffer(source: Pick<TerminalBuffer, "generation" | "buffer" | "bufferStart" | "nextOffset">, cursor: TerminalCursor = {}): TerminalSnapshot {
    const requestedOffset = Number(cursor.nextOffset);
    const canContinueFromCursor = cursor.generation === source.generation
      && Number.isSafeInteger(requestedOffset)
      && requestedOffset >= source.bufferStart
      && requestedOffset <= source.nextOffset;
    const maximum = Number(cursor.maxCatchUpBytes);
    const hasMaximum = Number.isSafeInteger(maximum) && maximum >= 0;
    if (canContinueFromCursor && hasMaximum && source.nextOffset - requestedOffset > maximum) {
      return {
        generation: source.generation,
        startOffset: requestedOffset,
        endOffset: requestedOffset,
        reset: false,
        dataBase64: "",
        catchUpExceeded: true,
      };
    }
    const canContinue = canContinueFromCursor;
    const startOffset = canContinue ? requestedOffset : source.bufferStart;
    const startIndex = startOffset - source.bufferStart;
    return {
      generation: source.generation,
      startOffset,
      endOffset: source.nextOffset,
      reset: !canContinue,
      dataBase64: source.buffer.subarray(startIndex).toString("base64"),
    };
}

function copyBuffer(source: TerminalBuffer): TerminalBuffer {
  return {
    generation: source.generation,
    buffer: Buffer.from(source.buffer),
    bufferStart: source.bufferStart,
    nextOffset: source.nextOffset,
    exitMarker: source.exitMarker,
    agentLabel: source.agentLabel,
  };
}

export function buildRemoteCodexCommand(remoteUrl: string, launch: TerminalLaunch, cwd: string, theme: TerminalTheme = "light"): string {
  const foreground = theme === "light" ? "Black" : "Gray";
  const background = theme === "light" ? "White" : "Black";
  const ansi = theme === "light" ? "30;47" : "37;40";
  const invocation = launch.mode === "resume"
    ? `& codex resume ${quoteArg(launch.threadId)} --remote ${quoteArg(remoteUrl)} --no-alt-screen -C ${quoteArg(cwd)} -c check_for_update_on_startup=false`
    : `& codex --remote ${quoteArg(remoteUrl)} --no-alt-screen -C ${quoteArg(cwd)} -c check_for_update_on_startup=false`;
  return `$env:NO_COLOR = \"1\"; Set-Location -LiteralPath ${quoteArg(cwd)}; $Host.UI.RawUI.ForegroundColor = \"${foreground}\"; $Host.UI.RawUI.BackgroundColor = \"${background}\"; $promptorEsc = [char]27; Write-Host -NoNewline \"$promptorEsc[${ansi}m\"; Clear-Host; ${invocation}; $promptorCodexOk = $?; $promptorCodexExit = $LASTEXITCODE; if ($null -eq $promptorCodexExit) { if ($promptorCodexOk) { $promptorCodexExit = 0 } else { $promptorCodexExit = 1 } }; Write-Output \"${CODEX_EXIT_MARKER}$promptorCodexExit\"`;
}

/**
 * The shell is spawned with `cwd` already applied; the Set-Location is there so
 * the first visible line confirms where the user landed. No NO_COLOR here --
 * that exists to tame an agent TUI, and a plain shell should keep its colors.
 */
export function buildShellCommand(cwd: string, theme: TerminalTheme = "light"): string {
  const foreground = theme === "light" ? "Black" : "Gray";
  const background = theme === "light" ? "White" : "Black";
  const ansi = theme === "light" ? "30;47" : "37;40";
  return `Set-Location -LiteralPath ${quoteArg(cwd)}; $Host.UI.RawUI.ForegroundColor = "${foreground}"; $Host.UI.RawUI.BackgroundColor = "${background}"; $promptorEsc = [char]27; Write-Host -NoNewline "$promptorEsc[${ansi}m"; Clear-Host`;
}

export function parseCodexExitCode(value: string): number | null {
  return parseAgentExitCode(value, CODEX_EXIT_MARKER);
}

export function parseAgentExitCode(value: string, marker: string): number | null {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = value.match(new RegExp(`${escaped}(-?\\d+)`));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function terminalStartupError(value: string, marker = CODEX_EXIT_MARKER, agentLabel = "Codex"): string | null {
  const exitCode = parseAgentExitCode(value, marker);
  if (exitCode === null) return null;
  const plain = value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ");
  if (/active writer|already has an active writer|thread\/resume failed.*writer/i.test(plain)) {
    return "thread/resume failed: thread already has an active writer";
  }
  return `${agentLabel} TUI exited before the session was attached (code ${exitCode}).`;
}

function quoteArg(value: string): string {
  if (!/^[A-Za-z0-9_:\/.?=&%+-]+$/.test(value)) return `'${value.replace(/'/g, "''")}'`;
  return value;
}
