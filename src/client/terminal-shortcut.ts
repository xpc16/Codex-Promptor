export type TerminalShortcut = "shift-tab" | "escape-twice" | "escape" | "tab";

/** Exact VT input emitted by the terminal header's one-click key menu. */
export function terminalShortcutInput(value: string): string | null {
  switch (value) {
    case "shift-tab": return "\x1b[Z";
    case "escape-twice": return "\x1b\x1b";
    case "escape": return "\x1b";
    case "tab": return "\t";
    default: return null;
  }
}
