import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSubmitTimers, scheduleSubmitRecovery, SUBMIT_RETRY_DELAYS_MS, SUBMIT_TIMEOUT_MS } from "./prompt-submit.js";

describe("dropped-Enter recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("re-sends Enter on a ladder before giving up on the prompt", () => {
    const resend = vi.fn();
    const giveUp = vi.fn();
    scheduleSubmitRecovery(resend, giveUp, [100, 300], 1_000);

    vi.advanceTimersByTime(99);
    expect(resend).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(resend).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(resend).toHaveBeenCalledTimes(2);
    expect(giveUp).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(giveUp).toHaveBeenCalledTimes(1);
  });

  it("stops retrying once the agent acknowledges the prompt", () => {
    const resend = vi.fn();
    const giveUp = vi.fn();
    const timers = scheduleSubmitRecovery(resend, giveUp, [100, 300], 1_000);

    vi.advanceTimersByTime(150);
    expect(resend).toHaveBeenCalledTimes(1);
    clearSubmitTimers(timers);
    vi.advanceTimersByTime(5_000);
    expect(resend).toHaveBeenCalledTimes(1);
    expect(giveUp).not.toHaveBeenCalled();
  });

  it("never schedules a retry that would land after the prompt already failed", () => {
    const resend = vi.fn();
    scheduleSubmitRecovery(resend, vi.fn(), [100, 5_000], 1_000);
    vi.advanceTimersByTime(10_000);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("keeps every retry inside the submit deadline", () => {
    expect(SUBMIT_RETRY_DELAYS_MS.every((delay) => delay > 0 && delay < SUBMIT_TIMEOUT_MS)).toBe(true);
    expect([...SUBMIT_RETRY_DELAYS_MS]).toEqual([...SUBMIT_RETRY_DELAYS_MS].sort((a, b) => a - b));
  });
});
