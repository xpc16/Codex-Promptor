import { describe, expect, it, vi } from "vitest";
import { TerminalScreenModel } from "./terminal-screen.js";

describe("TerminalScreenModel", () => {
  it("serializes parser writes and returns the bottom physical viewport", async () => {
    const screen = new TerminalScreenModel({ generation: "gen-1", cols: 12, rows: 6 });
    await screen.write("one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix");

    const snapshot = await screen.snapshot(5);
    expect(snapshot.generation).toBe("gen-1");
    expect(snapshot.revision).toBe(1);
    expect(snapshot.viewportTop).toBe(1);
    expect(snapshot.viewportRows).toBe(5);
    expect(snapshot.rows.map(rowText)).toEqual(["two", "three", "four", "five", "six"]);
    expect(snapshot.cursor).toMatchObject({ row: 4, col: 3, visible: true });
    screen.dispose();
  });

  it("handles split escape sequences, stable styled runs, CJK and combining text", async () => {
    const screen = new TerminalScreenModel({ generation: "gen-style", cols: 20, rows: 5 });
    const first = screen.write("plain \x1b[3");
    const second = screen.write("1;1m红e\u0301\x1b[0m");
    await Promise.all([first, second]);

    const snapshot = await screen.snapshot(5);
    const row = snapshot.rows[0];
    expect(rowText(row)).toBe("plain 红e\u0301");
    expect(row.runs).toHaveLength(2);
    expect(row.runs[1]).toMatchObject({
      text: "红e\u0301",
      style: { fg: 1, bg: "default", flags: ["bold"] },
    });
    expect(row.hash).toBe(JSON.stringify([false, row.runs]));
    screen.dispose();
  });

  it("coalesces a burst of contiguous PTY chunks into one parser revision", async () => {
    const screen = new TerminalScreenModel({ generation: "gen-burst", cols: 30, rows: 5 });
    const writes = Array.from({ length: 500 }, (_, index) => screen.write(`line-${index}\r\n`));
    await Promise.all(writes);

    const snapshot = await screen.snapshot(5);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.rows.map(rowText).join("\n")).toContain("line-499");
    screen.dispose();
  });

  it("tracks alternate screen, input modes and cursor visibility", async () => {
    const screen = new TerminalScreenModel({ generation: "gen-modes", cols: 20, rows: 5 });
    await screen.write("\x1b[?1049h\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?1000h\x1b[?1004hmenu\x1b[?25l");

    const active = await screen.snapshot(5);
    expect(active.alternateScreen).toBe(true);
    expect(active.inputModes).toEqual({
      applicationCursorKeys: true,
      applicationKeypad: true,
      bracketedPaste: true,
      mouseTracking: "vt200",
      sendFocus: true,
    });
    expect(active.cursor.visible).toBe(false);

    await screen.write("\x1b[?25h\x1b[?1049l");
    const normal = await screen.snapshot(5);
    expect(normal.alternateScreen).toBe(false);
    expect(normal.cursor.visible).toBe(true);
    screen.dispose();
  });

  it("orders resize behind preceding writes and advances sizeEpoch", async () => {
    const screen = new TerminalScreenModel({ generation: "gen-resize", cols: 10, rows: 5 });
    const write = screen.write("before");
    const resize = screen.resize(30, 8);
    const after = screen.write("-after");
    await Promise.all([write, resize, after]);

    const snapshot = await screen.snapshot(6);
    expect(snapshot).toMatchObject({ cols: 30, totalRows: 8, viewportRows: 6, viewportTop: 2, sizeEpoch: 1, revision: 3 });
    screen.dispose();
  });

  it("forwards protocol replies exactly once only while it owns the responder lease", async () => {
    const onResponse = vi.fn();
    const screen = new TerminalScreenModel({ generation: "gen-reply", cols: 20, rows: 5, theme: "dark", onResponse });
    await screen.write("\x1b[6n\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?996n");
    expect(onResponse.mock.calls.map(([value]) => value)).toEqual([
      "\x1b[1;1R",
      "\x1b]10;rgb:e5e5/eded/f8f8\x1b\\",
      "\x1b]11;rgb:0f0f/1717/2222\x1b\\",
      "\x1b[?997;1n",
    ]);

    screen.setResponderEnabled(false);
    await screen.write("\x1b[5n\x1b]10;?\x1b\\");
    expect(onResponse).toHaveBeenCalledTimes(4);
    screen.dispose();
  });
});

function rowText(row: { runs: Array<{ text: string }> }): string {
  return row.runs.map((run) => run.text).join("");
}
