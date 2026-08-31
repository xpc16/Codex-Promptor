import { describe, expect, it } from "vitest";
import { resolveTerminalInputHandle, terminalInputHandle, terminalInputIsPlain, TERMINAL_INPUT_COMPACT_TYPE } from "./terminal-input.js";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

describe("the compact keystroke envelope", () => {
  const tabId = "9eecca8f-2e3e-4e2b-8b4b-4569a4e3d357";

  it("costs a fraction of what the tab id and base64 did", () => {
    const before = JSON.stringify({ type: "terminal.input", tabId, dataBase64: "YQ==" });
    const after = JSON.stringify({ type: TERMINAL_INPUT_COMPACT_TYPE, s: terminalInputHandle(tabId), d: "a" });
    expect(before.length).toBe(92); // exactly what the traffic ledger measured
    expect(after.length).toBeLessThan(before.length / 2);
  });

  it("resolves a handle only against terminals the sender is attached to", () => {
    const subscribed = [tabId, "0b9849c8-8d41-4af3-b59d-7c2c1056ba14"];
    expect(resolveTerminalInputHandle(terminalInputHandle(tabId), subscribed)).toBe(tabId);
    expect(resolveTerminalInputHandle("da8d9464", subscribed)).toBeNull();
    expect(resolveTerminalInputHandle("", subscribed)).toBeNull();
    expect(resolveTerminalInputHandle(undefined, subscribed)).toBeNull();
  });

  it("refuses to guess between two terminals behind one handle", () => {
    expect(resolveTerminalInputHandle("9eecca8f", ["9eecca8f-aaaa", "9eecca8f-bbbb"])).toBeNull();
  });

  it("sends printable text as text and control sequences as base64", () => {
    expect(terminalInputIsPlain("a")).toBe(true);
    expect(terminalInputIsPlain("你好")).toBe(true);
    // An arrow key escapes to six JSON characters per control byte, which is
    // worse than the four base64 spends, so those keep taking the base64 route.
    expect(terminalInputIsPlain(ESC + "[A")).toBe(false);
    expect(terminalInputIsPlain(CR)).toBe(false);
  });
});
