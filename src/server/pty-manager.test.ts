import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  terminateProcessTree: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node-pty", () => ({ spawn: mocks.spawn }));
vi.mock("./codex.js", () => ({ terminateProcessTree: mocks.terminateProcessTree }));

import { PtyManager } from "./pty.js";

function fakePty() {
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;
  const process = {
    pid: 12345,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(),
    onExit: vi.fn((handler: (event: { exitCode: number }) => void) => { exitHandler = handler; }),
  };
  return { process, exit: (exitCode = 0) => exitHandler?.({ exitCode }) };
}

describe("PtyManager terminal sizing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.spawn.mockReset();
  });

  it("writes one draft space after Codex is ready and resets that guard for a new PTY", async () => {
    const first = fakePty();
    const second = fakePty();
    mocks.spawn.mockReturnValueOnce(first.process).mockReturnValueOnce(second.process);
    const manager = new PtyManager();

    expect(manager.primeCodexInput("tab-prime")).toBe(false);
    await manager.start("tab-prime", "C:\\work", "ws://127.0.0.1:4500", { mode: "new" });
    vi.advanceTimersByTime(180);
    expect(first.process.write).toHaveBeenCalledTimes(1);
    expect(manager.primeCodexInput("tab-prime")).toBe(true);
    expect(manager.primeCodexInput("tab-prime")).toBe(false);
    expect(first.process.write).toHaveBeenCalledTimes(2);
    expect(first.process.write).toHaveBeenLastCalledWith(" ");

    await manager.start("tab-prime", "C:\\work", "ws://127.0.0.1:4501", { mode: "new" });
    vi.advanceTimersByTime(180);
    expect(manager.primeCodexInput("tab-prime")).toBe(true);
    expect(second.process.write).toHaveBeenLastCalledWith(" ");

    second.exit();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("uses a size received before launch and deduplicates later resizes", async () => {
    const child = fakePty();
    mocks.spawn.mockReturnValue(child.process);
    const manager = new PtyManager();

    expect(manager.resize("tab-1", 118, 27)).toBe(true);
    await manager.start("tab-1", "C:\\work", "ws://127.0.0.1:4500", { mode: "new" });

    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cols: 118, rows: 27 }));
    expect(manager.resize("tab-1", 118, 27)).toBe(false);
    expect(child.process.resize).not.toHaveBeenCalled();

    expect(manager.resize("tab-1", 120, 28)).toBe(true);
    expect(manager.resize("tab-1", 120, 28)).toBe(false);
    expect(child.process.resize).toHaveBeenCalledTimes(1);
    expect(child.process.resize).toHaveBeenCalledWith(120, 28);

    child.exit();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("forgets a deleted tab's previously requested dimensions", async () => {
    const child = fakePty();
    mocks.spawn.mockReturnValue(child.process);
    const manager = new PtyManager();

    manager.resize("tab-2", 140, 35);
    manager.forgetSize("tab-2");
    await manager.start("tab-2", "C:\\work", "ws://127.0.0.1:4500", { mode: "new" });

    expect(mocks.spawn).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ cols: 80, rows: 12 }));

    child.exit();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});

describe("PtyManager prompt submission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.spawn.mockReset();
  });

  it("sends the pasted prompt and its Enter as separate writes", async () => {
    const term = fakePty();
    mocks.spawn.mockReturnValueOnce(term.process);
    const manager = new PtyManager();
    await manager.start("tab-submit", "C:\\work", "ws://127.0.0.1:4500", { mode: "new" });
    vi.advanceTimersByTime(180);
    term.process.write.mockClear();

    expect(manager.submitPrompt("tab-submit", "hello")).toBe(true);
    // The paste alone: an Enter riding in the same chunk is the one a busy TUI
    // drops, leaving the prompt sitting in the input box unsent.
    expect(term.process.write).toHaveBeenCalledTimes(1);
    expect(term.process.write).toHaveBeenLastCalledWith("\x1b[200~hello\x1b[201~");

    vi.advanceTimersByTime(200);
    expect(term.process.write).toHaveBeenCalledTimes(2);
    expect(term.process.write).toHaveBeenLastCalledWith("\r");

    // Recovery path: the queue re-arms Enter without re-pasting the prompt.
    expect(manager.submitEnter("tab-submit")).toBe(true);
    expect(term.process.write).toHaveBeenCalledTimes(3);
    expect(term.process.write).toHaveBeenLastCalledWith("\r");

    term.exit();
    expect(manager.submitPrompt("tab-submit", "after exit")).toBe(false);
    expect(manager.submitEnter("tab-submit")).toBe(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });
});
