export type TerminalShortcut = "shift-tab" | "escape-twice" | "escape" | "tab" | "alt-up";

/** Exact VT input emitted by the terminal header's one-click key menu. */
export function terminalShortcutInput(value: string): string | null {
  switch (value) {
    case "shift-tab": return "\x1b[Z";
    case "escape-twice": return "\x1b\x1b";
    case "escape": return "\x1b";
    case "tab": return "\t";
    // Codex opens a queued question with this. A phone has no Alt key, and a
    // desktop's Alt+Up is rewritten by xterm.js (see altArrowSequence), so the
    // menu is the one place that sends the real chord on every device.
    case "alt-up": return "\x1b[1;3A";
    default: return null;
  }
}

type KeyLike = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean };

/**
 * The xterm-standard sequence for Alt+Up / Alt+Down, which xterm.js itself
 * does not send.
 *
 * xterm.js (5.5, `Keyboard.ts`) rewrites `ESC [1;3A` into `ESC [1;5A` on
 * every platform but macOS -- "make Alt+Up behave like Ctrl+Up" -- so a TUI
 * bound to Alt+Up never sees it. Codex CLI is such a TUI: its footer says
 * "Alt+↑ to answer" when a question is waiting, and pressing it did nothing,
 * because what arrived was Ctrl+Up. Measured through ConPTY, `ESC [1;3A`
 * comes out as ALT-down, UP(with ALT), UP-up, ALT-up -- exactly the native
 * shape -- so the sequence itself is right; only xterm.js was in the way.
 *
 * Left/Right are deliberately left to xterm.js: its rewrite there gives
 * word movement in shells that bind Ctrl+arrow, which is what a terminal
 * user expects, and nothing here needs the Alt form.
 */
export function altArrowSequence(event: KeyLike): string | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const letter = event.key === "ArrowUp" ? "A" : event.key === "ArrowDown" ? "B" : null;
  if (!letter) return null;
  // xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4).
  return `\x1b[1;${event.shiftKey ? 4 : 3}${letter}`;
}
