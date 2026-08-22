import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import { terminateProcessTree } from "./codex.js";

export type TerminalEvent =
  | { tabId: string; type: "output"; generation: string; startOffset: number; endOffset: number; dataBase64: string }
  | { tabId: string; type: "state"; state: "stopped" | "starting" | "running" | "exited" | "error"; exitCode?: number | null; message?: string };

export type TerminalTheme = "light" | "dark";

type TerminalBuffer = { generation: string; buffer: Buffer; bufferStart: number; nextOffset: number };
type Session = TerminalBuffer & { process: pty.IPty; codexExited: boolean };

export type TerminalCursor = { generation?: string | null; nextOffset?: number | null };
export type TerminalSnapshot = {
  generation: string;
  startOffset: number;
  endOffset: number;
  reset: boolean;
  dataBase64: string;
};

const CODEX_EXIT_MARKER = "__CODEX_PROMPTOR_EXIT__:";
const MAX_BUFFER_BYTES = 1_000_000;

export class PtyManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly archives = new Map<string, TerminalBuffer>();

  async start(tabId: string, cwd: string, remoteUrl: string, threadId: string, theme: TerminalTheme = "light"): Promise<void> {
    await this.stop(tabId, false);
    this.archives.delete(tabId);
    this.emitEvent({ tabId, type: "state", state: "starting" });
    try {
      const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
      const child = pty.spawn(shell, ["-NoLogo", "-NoExit", "-NoProfile"], {
        name: "xterm-256color",
        cols: 80,
        rows: 12,
        cwd,
        env: process.env as Record<string, string>,
        useConpty: true,
      });
      const session: Session = { process: child, generation: randomUUID(), buffer: Buffer.alloc(0), bufferStart: 0, nextOffset: 0, codexExited: false };
      this.sessions.set(tabId, session);
      child.onData((data) => {
        const bytes = Buffer.from(data, "utf8");
        const startOffset = session.nextOffset;
        session.nextOffset += bytes.length;
        session.buffer = Buffer.concat([session.buffer, bytes]);
        if (session.buffer.length > MAX_BUFFER_BYTES) {
          const overflow = session.buffer.length - MAX_BUFFER_BYTES;
          session.buffer = session.buffer.subarray(overflow);
          session.bufferStart += overflow;
        }
        this.emitEvent({ tabId, type: "output", generation: session.generation, startOffset, endOffset: session.nextOffset, dataBase64: bytes.toString("base64") });
        const exitCode = parseCodexExitCode(session.buffer.toString("utf8"));
        if (exitCode !== null && !session.codexExited) {
          session.codexExited = true;
          this.emitEvent(exitCode === 0
            ? { tabId, type: "state", state: "exited", exitCode }
            : { tabId, type: "state", state: "error", exitCode, message: `Codex TUI exited with code ${exitCode}. PowerShell remains available.` });
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
        child.write(`${buildRemoteCodexCommand(remoteUrl, threadId, cwd, theme)}\r`);
      }, 180);
    } catch (error) {
      this.emitEvent({ tabId, type: "state", state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  write(tabId: string, data: string): void { this.sessions.get(tabId)?.process.write(data); }
  resize(tabId: string, cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 5 || cols > 500 || rows > 200) return;
    try { this.sessions.get(tabId)?.process.resize(cols, rows); } catch { /* process exited between lookup and resize */ }
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
  async stopAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map((tabId) => this.stop(tabId))); }
  has(tabId: string): boolean { return this.sessions.has(tabId); }
  snapshot(tabId: string, cursor: TerminalCursor = {}): TerminalSnapshot | null {
    const source = this.sessions.get(tabId) ?? this.archives.get(tabId);
    if (!source) return null;
    return sliceTerminalBuffer(source, cursor);
  }

  private emitEvent(event: TerminalEvent): void { this.emit("event", event); }
}

export function sliceTerminalBuffer(source: Pick<TerminalBuffer, "generation" | "buffer" | "bufferStart" | "nextOffset">, cursor: TerminalCursor = {}): TerminalSnapshot {
    const requestedOffset = Number(cursor.nextOffset);
    const canContinue = cursor.generation === source.generation
      && Number.isSafeInteger(requestedOffset)
      && requestedOffset >= source.bufferStart
      && requestedOffset <= source.nextOffset;
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
  return { generation: source.generation, buffer: Buffer.from(source.buffer), bufferStart: source.bufferStart, nextOffset: source.nextOffset };
}

export function buildRemoteCodexCommand(remoteUrl: string, threadId: string, cwd: string, theme: TerminalTheme = "light"): string {
  const foreground = theme === "light" ? "Black" : "Gray";
  const background = theme === "light" ? "White" : "Black";
  const ansi = theme === "light" ? "30;47" : "37;40";
  return `$env:NO_COLOR = \"1\"; Set-Location -LiteralPath ${quoteArg(cwd)}; $Host.UI.RawUI.ForegroundColor = \"${foreground}\"; $Host.UI.RawUI.BackgroundColor = \"${background}\"; $promptorEsc = [char]27; Write-Host -NoNewline \"$promptorEsc[${ansi}m\"; Clear-Host; & codex resume ${quoteArg(threadId)} --remote ${quoteArg(remoteUrl)} -C ${quoteArg(cwd)} -c check_for_update_on_startup=false; $promptorCodexOk = $?; $promptorCodexExit = $LASTEXITCODE; if ($null -eq $promptorCodexExit) { if ($promptorCodexOk) { $promptorCodexExit = 0 } else { $promptorCodexExit = 1 } }; Write-Output \"${CODEX_EXIT_MARKER}$promptorCodexExit\"`;
}

export function parseCodexExitCode(value: string): number | null {
  const match = value.match(new RegExp(`${CODEX_EXIT_MARKER}(-?\\d+)`));
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function quoteArg(value: string): string {
  if (!/^[A-Za-z0-9_:\/.?=&%+-]+$/.test(value)) return `'${value.replace(/'/g, "''")}'`;
  return value;
}
