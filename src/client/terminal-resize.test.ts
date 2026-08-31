import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalCursorQuietScheduler, TerminalResizeScheduler } from "./terminal-resize.js";

describe("TerminalResizeScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid layout changes into one PTY resize", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const scheduler = new TerminalResizeScheduler(send, 200);

    scheduler.schedule({ cols: 80, rows: 12 });
    vi.advanceTimersByTime(80);
    scheduler.schedule({ cols: 96, rows: 18 });
    vi.advanceTimersByTime(80);
    scheduler.schedule({ cols: 110, rows: 22 });

    vi.advanceTimersByTime(199);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ cols: 110, rows: 22 });
  });

  it("does not resend an unchanged size or postpone a stable pending size", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const scheduler = new TerminalResizeScheduler(send, 100);

    scheduler.schedule({ cols: 100, rows: 20 });
    vi.advanceTimersByTime(60);
    scheduler.schedule({ cols: 100, rows: 20 });
    vi.advanceTimersByTime(40);
    expect(send).toHaveBeenCalledTimes(1);

    scheduler.schedule({ cols: 100, rows: 20 });
    vi.advanceTimersByTime(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resends the current size after a terminal generation changes", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const scheduler = new TerminalResizeScheduler(send, 100);

    scheduler.schedule({ cols: 120, rows: 30 });
    vi.runAllTimers();
    scheduler.invalidate();
    scheduler.schedule({ cols: 120, rows: 30 });
    vi.runAllTimers();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending resize when the layout returns to the last sent size", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const scheduler = new TerminalResizeScheduler(send, 100);

    scheduler.schedule({ cols: 90, rows: 16 });
    vi.runAllTimers();
    scheduler.schedule({ cols: 91, rows: 16 });
    scheduler.schedule({ cols: 90, rows: 16 });
    vi.runAllTimers();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("ignores one-cell measurement noise around the persisted PTY size", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const scheduler = new TerminalResizeScheduler(send, 100, { cols: 100, rows: 20 });

    scheduler.schedule({ cols: 101, rows: 21 });
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();

    scheduler.schedule({ cols: 102, rows: 20 });
    vi.runAllTimers();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ cols: 102, rows: 20 });
  });
});

describe("TerminalCursorQuietScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps the cursor suppressed until a complete quiet interval elapses", () => {
    vi.useFakeTimers();
    const setSuppressed = vi.fn();
    const scheduler = new TerminalCursorQuietScheduler(setSuppressed, 180);

    scheduler.beginWrite();
    scheduler.finishWrite();
    vi.advanceTimersByTime(120);
    scheduler.beginWrite();
    scheduler.finishWrite();

    vi.advanceTimersByTime(179);
    expect(setSuppressed).toHaveBeenCalledTimes(1);
    expect(setSuppressed).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(1);
    expect(setSuppressed).toHaveBeenLastCalledWith(false);
  });

  it("cancels a pending reveal and restores the cursor when disposed", () => {
    vi.useFakeTimers();
    const setSuppressed = vi.fn();
    const scheduler = new TerminalCursorQuietScheduler(setSuppressed, 180);

    scheduler.beginWrite();
    scheduler.finishWrite();
    scheduler.dispose();
    vi.runAllTimers();

    expect(setSuppressed.mock.calls).toEqual([[true], [false]]);
  });
});

describe("emulator and PTY size agreement", () => {
  it("keeps the emulator on the size the PTY still believes in", () => {
    // Within tolerance the PTY is deliberately not resized. The emulator must
    // then stay at the PTY's size: a one-column disagreement makes a TUI that
    // repaints by moving the cursor wrap differently than the emulator does,
    // and every later repaint compounds the damage.
    const scheduler = new TerminalResizeScheduler(() => undefined, 220, { cols: 80, rows: 24 });
    expect(scheduler.effectiveSize({ cols: 81, rows: 24 })).toEqual({ cols: 80, rows: 24 });
    expect(scheduler.effectiveSize({ cols: 83, rows: 24 })).toEqual({ cols: 83, rows: 24 });
  });

  it("does not strand the emulator after a drag walks back inside tolerance", () => {
    const sent: Array<{ cols: number; rows: number }> = [];
    const scheduler = new TerminalResizeScheduler((size) => sent.push(size), 220, { cols: 80, rows: 24 });

    // A drag overshoots out of tolerance, then settles one column off.
    expect(scheduler.effectiveSize({ cols: 83, rows: 24 })).toEqual({ cols: 83, rows: 24 });
    scheduler.schedule({ cols: 83, rows: 24 });
    const settled = scheduler.effectiveSize({ cols: 81, rows: 24 });
    scheduler.schedule({ cols: 81, rows: 24 });
    scheduler.flush();

    // The pending resize is correctly dropped, so the emulator has to go back
    // to 80 rather than sit at 81 that the PTY was never told about.
    expect(sent).toEqual([]);
    expect(settled).toEqual({ cols: 80, rows: 24 });
  });

  it("absorbs a row of vertical noise that it would not absorb across", () => {
    // A banner appearing and disappearing costs a row
    // or two. Repainting a whole TUI screen for that is a bad trade, and the
    // emulator sitting one row short of the pane is only unused space. The same
    // slack sideways is not free: the two would wrap text differently.
    const send = vi.fn();
    const scheduler = new TerminalResizeScheduler(send, 100, { cols: 100, rows: 20 });

    expect(scheduler.effectiveSize({ cols: 100, rows: 22 })).toEqual({ cols: 100, rows: 20 });
    expect(scheduler.effectiveSize({ cols: 100, rows: 23 })).toEqual({ cols: 100, rows: 23 });
    expect(scheduler.effectiveSize({ cols: 102, rows: 20 })).toEqual({ cols: 102, rows: 20 });
  });

  it("accepts any size once a new PTY generation invalidates what was sent", () => {
    const scheduler = new TerminalResizeScheduler(() => undefined, 220, { cols: 80, rows: 24 });
    scheduler.invalidate();
    expect(scheduler.effectiveSize({ cols: 81, rows: 24 })).toEqual({ cols: 81, rows: 24 });
  });
});
