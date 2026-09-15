import { describe, expect, it } from "vitest";
import { altArrowSequence, terminalShortcutInput } from "./terminal-shortcut.js";

describe("terminal shortcut input", () => {
  it("maps menu choices to their exact VT key sequences", () => {
    expect(terminalShortcutInput("shift-tab")).toBe("\x1b[Z");
    expect(terminalShortcutInput("escape-twice")).toBe("\x1b\x1b");
    expect(terminalShortcutInput("escape")).toBe("\x1b");
    expect(terminalShortcutInput("tab")).toBe("\t");
    // What Codex binds "answer the queued question" to, reachable from a
    // phone that has no Alt key.
    expect(terminalShortcutInput("alt-up")).toBe("\x1b[1;3A");
    expect(terminalShortcutInput("")).toBeNull();
  });
});

describe("Alt+arrow, sent as itself", () => {
  const key = (overrides: Partial<{ key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }>) =>
    ({ key: "ArrowUp", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...overrides });

  it("gives Alt+Up the xterm sequence xterm.js rewrites away", () => {
    // xterm.js turns this into ESC [1;5A -- Ctrl+Up -- and Codex's
    // "Alt+↑ to answer" never fires. The modifier parameter for Alt is 3.
    expect(altArrowSequence(key({}))).toBe("\x1b[1;3A");
    expect(altArrowSequence(key({ key: "ArrowDown" }))).toBe("\x1b[1;3B");
    expect(altArrowSequence(key({ shiftKey: true }))).toBe("\x1b[1;4A");
  });

  it("leaves every other key to xterm.js", () => {
    expect(altArrowSequence(key({ altKey: false }))).toBeNull();
    // Ctrl+Alt+Up is 1;7 and xterm.js sends it correctly on its own.
    expect(altArrowSequence(key({ ctrlKey: true }))).toBeNull();
    expect(altArrowSequence(key({ metaKey: true }))).toBeNull();
    // Left/Right keep xterm.js's word-movement rewrite, which shells rely on.
    expect(altArrowSequence(key({ key: "ArrowLeft" }))).toBeNull();
    expect(altArrowSequence(key({ key: "ArrowRight" }))).toBeNull();
    expect(altArrowSequence(key({ key: "a" }))).toBeNull();
  });
});
