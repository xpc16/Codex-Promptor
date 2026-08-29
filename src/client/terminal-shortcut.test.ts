import { describe, expect, it } from "vitest";
import { terminalShortcutInput } from "./terminal-shortcut.js";

describe("terminal shortcut input", () => {
  it("maps menu choices to their exact VT key sequences", () => {
    expect(terminalShortcutInput("shift-tab")).toBe("\x1b[Z");
    expect(terminalShortcutInput("escape-twice")).toBe("\x1b\x1b");
    expect(terminalShortcutInput("escape")).toBe("\x1b");
    expect(terminalShortcutInput("tab")).toBe("\t");
    expect(terminalShortcutInput("")).toBeNull();
  });
});
