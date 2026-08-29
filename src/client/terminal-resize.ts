export type TerminalSize = { cols: number; rows: number };

/**
 * How far the measured size may drift from the PTY's before it is worth telling
 * ConPTY, which makes a TUI repaint its whole screen.
 *
 * Rows are looser than columns because vertical noise is routine and cheap to
 * absorb: an error banner or the settling overlay appearing takes a row or two
 * and gives them straight back, and the only cost of the emulator holding the
 * PTY's row count meanwhile is a little unused space at the bottom. A column
 * disagreement is not cosmetic -- the two sides then wrap text differently and
 * a cursor-repainting TUI degrades with every frame -- so columns stay tight.
 */
export const DEFAULT_TERMINAL_SIZE_TOLERANCE: TerminalSize = { cols: 1, rows: 2 };

export function sameTerminalSize(left: TerminalSize | null, right: TerminalSize | null): boolean {
  return Boolean(left && right && left.cols === right.cols && left.rows === right.rows);
}

export function terminalSizeWithinTolerance(
  left: TerminalSize | null,
  right: TerminalSize | null,
  tolerance: TerminalSize = DEFAULT_TERMINAL_SIZE_TOLERANCE,
): boolean {
  return Boolean(left && right
    && Math.abs(left.cols - right.cols) <= tolerance.cols
    && Math.abs(left.rows - right.rows) <= tolerance.rows);
}

export function terminalFrameLooksSettled(lines: string[]): boolean {
  const hasInputPrompt = lines.some((line) => /^\s*›(?:\s|$)/u.test(line));
  const hasModelStatus = lines.some((line) => /\b(?:gpt(?:-[\w.]+)+|o\d(?:-[\w.]+)*)\b/iu.test(line));
  return hasInputPrompt && hasModelStatus;
}

export function terminalResetNeedsSettling(provider: string, longTerminal: boolean, reason: unknown): boolean {
  return provider === "codex" && longTerminal && reason !== "context_compacted";
}

/**
 * Keeps xterm's cursor hidden while a burst of TUI output is being painted.
 * Codex emits one visual frame as many small writes; revealing the cursor after
 * every write exposes its intermediate coordinates and looks like a jumping
 * caret. The cursor is restored only after output has stayed quiet.
 */
export class TerminalCursorQuietScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private suppressed = false;

  constructor(
    private readonly setSuppressed: (suppressed: boolean) => void,
    private readonly quietMs = 180,
  ) {}

  beginWrite(): void {
    this.cancelTimer();
    if (this.suppressed) return;
    this.suppressed = true;
    this.setSuppressed(true);
  }

  finishWrite(): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.suppressed) return;
      this.suppressed = false;
      this.setSuppressed(false);
    }, this.quietMs);
  }

  dispose(): void {
    this.cancelTimer();
    if (!this.suppressed) return;
    this.suppressed = false;
    this.setSuppressed(false);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Coalesces a burst of layout changes before resizing the real PTY.
 * xterm can resize locally on every frame, but each PTY resize makes a TUI
 * repaint its entire screen, which is particularly expensive for long threads.
 */
export class TerminalResizeScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: TerminalSize | null = null;
  private sent: TerminalSize | null;

  constructor(
    private readonly send: (size: TerminalSize) => void,
    private readonly delayMs = 220,
    initialSent: TerminalSize | null = null,
    private readonly tolerance: TerminalSize = DEFAULT_TERMINAL_SIZE_TOLERANCE,
  ) {
    this.sent = initialSent ? { ...initialSent } : null;
  }

  schedule(size: TerminalSize): void {
    const next = { cols: size.cols, rows: size.rows };
    if (sameTerminalSize(this.pending, next)) return;
    this.pending = next;

    if (terminalSizeWithinTolerance(this.sent, next, this.tolerance)) {
      this.cancelTimer();
      this.pending = null;
      return;
    }

    this.cancelTimer();
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  /** A new WebSocket or PTY generation must receive the current size once. */
  invalidate(): void {
    this.sent = null;
  }

  /**
   * The size the emulator must currently render at.
   *
   * Within tolerance the PTY is deliberately left alone, so the emulator has to
   * stay at the size the PTY still believes in. Letting the two disagree by
   * even one column breaks any TUI that repaints by moving the cursor rather
   * than clearing: it wraps at the PTY width while the emulator wraps at its
   * own, so each repaint lands a little further off and the screen degrades as
   * the turn goes on. Claude Code runs on the classic main-screen renderer
   * here (the alternate screen is disabled so output reaches scrollback), which
   * is exactly that kind of repaint.
   */
  effectiveSize(proposed: TerminalSize): TerminalSize {
    if (this.sent && terminalSizeWithinTolerance(this.sent, proposed, this.tolerance)) return { ...this.sent };
    return { cols: proposed.cols, rows: proposed.rows };
  }

  flush(): void {
    this.cancelTimer();
    const next = this.pending;
    this.pending = null;
    if (!next || terminalSizeWithinTolerance(this.sent, next, this.tolerance)) return;
    this.sent = next;
    this.send(next);
  }

  dispose(): void {
    this.cancelTimer();
    this.pending = null;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
