import { describe, expect, it } from "vitest";
import { buildRemoteCodexCommand, CODEX_EXIT_MARKER, parseAgentExitCode, parseCodexExitCode, sessionExitMarker, sliceTerminalBuffer, terminalStartupError } from "./pty.js";

describe("remote Codex terminal command", () => {
  it("resumes the selected remote thread in the selected working directory", () => {
    const command = buildRemoteCodexCommand("ws://127.0.0.1:4500", { mode: "resume", threadId: "01a00000-0000-7000-8000-000000000001" }, "C:\\Users\\Tester Workspace", "dark");
    expect(command).toContain("Set-Location -LiteralPath 'C:\\Users\\Tester Workspace'");
    expect(command).toContain("codex resume 01a00000-0000-7000-8000-000000000001 --remote ws://127.0.0.1:4500 --no-alt-screen -C 'C:\\Users\\Tester Workspace'");
    expect(command).toContain('$Host.UI.RawUI.BackgroundColor = "Black"');
    expect(command).toContain("check_for_update_on_startup=false");
    expect(command).toContain("__CODEX_PROMPTOR_EXIT__:");
  });

  it("uses a light PowerShell palette in light mode", () => {
    const command = buildRemoteCodexCommand("ws://127.0.0.1:4500", { mode: "resume", threadId: "01a00000-0000-7000-8000-000000000001" }, "C:\\work", "light");
    expect(command).toContain('$Host.UI.RawUI.ForegroundColor = "Black"');
    expect(command).toContain('$Host.UI.RawUI.BackgroundColor = "White"');
    expect(command).toContain("[30;47m");
  });

  it("lets the remote TUI create a fresh thread without trying to resume an unsaved id", () => {
    const command = buildRemoteCodexCommand("ws://127.0.0.1:4500", { mode: "new" }, "C:\\work", "light");
    expect(command).toContain("codex --remote ws://127.0.0.1:4500 --no-alt-screen -C 'C:\\work'");
    expect(command).not.toContain("codex resume");
  });

  it("reads a split-buffer exit marker only after the exit code arrives", () => {
    expect(parseCodexExitCode("output __CODEX_PROMPTOR_EXIT__:")).toBeNull();
    expect(parseCodexExitCode("output __CODEX_PROMPTOR_EXIT__:17\r\nPS>")).toBe(17);
  });

  it("cannot be told the agent exited by something the agent merely displayed", () => {
    const marker = sessionExitMarker(CODEX_EXIT_MARKER);
    // This repository's own sources contain the fixed marker followed by a
    // number, so an agent working here that shows one of them used to report
    // itself dead: the banner stuck, and prompt submission stopped.
    const shownInTheTui = `expect(parseCodexExitCode("output ${CODEX_EXIT_MARKER}17\r\nPS>")).toBe(17);`;
    expect(parseAgentExitCode(shownInTheTui, marker)).toBeNull();
    expect(parseAgentExitCode(`${shownInTheTui}\r\n${marker}17\r\n`, marker)).toBe(17);
  });

  it("gives each session a marker nothing written earlier can contain", () => {
    const first = sessionExitMarker(CODEX_EXIT_MARKER);
    const second = sessionExitMarker(CODEX_EXIT_MARKER);
    expect(first.startsWith(CODEX_EXIT_MARKER)).toBe(true);
    expect(first).not.toBe(second);
    expect(parseAgentExitCode(`${first}0\r\n`, second)).toBeNull();
  });

  it("puts the session marker into the command that will announce it", () => {
    const marker = sessionExitMarker(CODEX_EXIT_MARKER);
    const command = buildRemoteCodexCommand("ws://127.0.0.1:4500", { mode: "new" }, "C:\\work", "light", marker);
    expect(command).toContain(`Write-Output "${marker}$promptorCodexExit"`);
  });

  it("waits for the number to be finished before believing it", () => {
    const marker = sessionExitMarker(CODEX_EXIT_MARKER);
    // A read that ends mid-number would otherwise settle as 1 and latch there,
    // leaving the real code 17 unreported.
    expect(parseAgentExitCode(`${marker}1`, marker)).toBeNull();
    expect(parseAgentExitCode(`${marker}17\r\n`, marker)).toBe(17);
  });

  it("surfaces an active writer failure while waiting for the TUI to attach", () => {
    expect(terminalStartupError("Error: thread already has an active writer\r\n__CODEX_PROMPTOR_EXIT__:1\r\n"))
      .toContain("active writer");
    expect(terminalStartupError("__CODEX_PROMPTOR_EXIT__:0\r\n")).toContain("code 0");
  });

  it("sends only the missing terminal bytes for a matching cursor", () => {
    const source = { generation: "generation-1", buffer: Buffer.from("abcdef", "utf8"), bufferStart: 10, nextOffset: 16 };
    const delta = sliceTerminalBuffer(source, { generation: "generation-1", nextOffset: 13 });
    expect(delta).toMatchObject({ generation: "generation-1", startOffset: 13, endOffset: 16, reset: false });
    expect(Buffer.from(delta.dataBase64, "base64").toString("utf8")).toBe("def");
  });

  it("resets to the retained snapshot for an old or different cursor", () => {
    const source = { generation: "generation-2", buffer: Buffer.from("retained", "utf8"), bufferStart: 25, nextOffset: 33 };
    const snapshot = sliceTerminalBuffer(source, { generation: "generation-1", nextOffset: 100 });
    expect(snapshot).toMatchObject({ generation: "generation-2", startOffset: 25, endOffset: 33, reset: true });
    expect(Buffer.from(snapshot.dataBase64, "base64").toString("utf8")).toBe("retained");
  });

  it("refuses to replay a raw gap beyond the requested catch-up bound", () => {
    const source = { generation: "generation-1", buffer: Buffer.from("x".repeat(100), "utf8"), bufferStart: 0, nextOffset: 100 };
    const snapshot = sliceTerminalBuffer(source, { generation: "generation-1", nextOffset: 10, maxCatchUpBytes: 32 });
    expect(snapshot).toMatchObject({ startOffset: 10, endOffset: 10, reset: false, catchUpExceeded: true, dataBase64: "" });
  });

  it("treats a cursor that fell out of the buffer as over the bound too", () => {
    // The largest gap there is, answered until now with the whole retained
    // buffer -- which the browser paints a chunk per frame, so the terminal
    // fast-forwards through it instead of showing where things ended up.
    const source = { generation: "generation-1", buffer: Buffer.from("x".repeat(100), "utf8"), bufferStart: 400, nextOffset: 500 };
    const stale = sliceTerminalBuffer(source, { generation: "generation-1", nextOffset: 12, maxCatchUpBytes: 64 });
    expect(stale).toMatchObject({ startOffset: 500, endOffset: 500, reset: false, catchUpExceeded: true, dataBase64: "" });
    // Without a bound the retained buffer is still the right answer.
    expect(sliceTerminalBuffer(source, { generation: "generation-1", nextOffset: 12 })).toMatchObject({ reset: true });
  });
});
