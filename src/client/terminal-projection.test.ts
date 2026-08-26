import { describe, expect, it } from "vitest";
import type { TerminalScreenFrame } from "../shared/terminal-protocol.js";
import { applyProjectionFrame, projectionScreenToAnsi } from "./terminal-projection.js";

describe("projection client state", () => {
  it("builds a full screen, applies scroll before rows and accepts revision jumps", () => {
    const first = frame(1, true, ["A", "B", "C", "D", "status"]);
    const initial = applyProjectionFrame(null, first);
    expect(initial.applied).toBe(true);
    expect(initial.state?.rows.map(rowText)).toEqual(["A", "B", "C", "D", "status"]);

    const update = frame(2, false, []);
    update.revision = 20;
    update.scroll = { top: 0, bottom: 3, lines: 1 };
    update.rows = [row(3, "E")];
    const applied = applyProjectionFrame(initial.state, update);
    expect(applied.state?.rows.map(rowText)).toEqual(["B", "C", "D", "E", "status"]);
    expect(applied.state?.revision).toBe(20);
  });

  it("requests a snapshot on sequence gaps or structural increments without a full frame", () => {
    const initial = applyProjectionFrame(null, frame(1, true, ["ready"])).state;
    expect(applyProjectionFrame(initial, frame(3, false, ["missed"]))).toMatchObject({ applied: false, needsSnapshot: true });
    const resized = frame(2, false, ["resized"]);
    resized.sizeEpoch = 1;
    expect(applyProjectionFrame(initial, resized)).toMatchObject({ applied: false, needsSnapshot: true });
  });

  it("turns only sanitized cells and allowlisted styles into local ANSI", () => {
    const unsafe = frame(1, true, ["ignored"]);
    unsafe.rows = [{
      row: 0,
      clearToEnd: true,
      runs: [{ text: "safe\x1b]52;c;ZXZpbA==\x07", style: { fg: "#12abef", bg: 4, flags: ["bold"] } }],
    }];
    const state = applyProjectionFrame(null, unsafe).state!;
    const ansi = projectionScreenToAnsi(state);
    expect(ansi).toContain("safe�]52;c;ZXZpbA==�");
    expect(ansi).not.toContain("\x1b]52");
    expect(ansi).toContain("\x1b[0;1;38;2;18;171;239;44m");
  });
});

function frame(sequence: number, full: boolean, lines: string[]): TerminalScreenFrame {
  const viewportRows = Math.max(5, lines.length);
  return {
    type: "terminal.screen",
    tabId: "tab",
    generation: "generation",
    streamId: "stream",
    sequence,
    revision: sequence,
    full,
    cols: 80,
    totalRows: viewportRows,
    viewportTop: 0,
    viewportRows,
    alternateScreen: false,
    sizeEpoch: 0,
    inputModes: {
      applicationCursorKeys: false,
      applicationKeypad: false,
      bracketedPaste: false,
      mouseTracking: "none",
      sendFocus: false,
    },
    cursor: { row: 0, col: 0, visible: true },
    rows: lines.map((text, index) => row(index, text)),
  };
}

function row(index: number, text: string) {
  return { row: index, clearToEnd: true as const, runs: [{ text, style: { fg: "default" as const, bg: "default" as const, flags: [] } }] };
}

function rowText(value: { runs: Array<{ text: string }> }): string { return value.runs.map((run) => run.text).join(""); }

