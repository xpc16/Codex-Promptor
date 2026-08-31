import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSubmitTimers,
  sameSubmittedPrompt,
  scheduleSubmitRecovery,
  SUBMIT_RETRY_DELAYS_MS,
  SUBMIT_TIMEOUT_MS,
  type SubmitEvidence,
} from "./prompt-submit.js";

describe("evidence-gated prompt submission recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it("re-sends Enter only when a recognized record says no prompt was submitted", async () => {
    const resend = vi.fn();
    const unconfirmed = vi.fn();
    const inspect = vi.fn<() => Promise<SubmitEvidence>>().mockResolvedValue({ state: "not-submitted" });
    scheduleSubmitRecovery({ inspect, resend, accept: vi.fn(), unconfirmed }, [100, 300], 1_000);

    await vi.advanceTimersByTimeAsync(99);
    expect(resend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(resend).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(700);
    expect(unconfirmed).toHaveBeenCalledWith({ state: "unknown", reason: "PERSISTENT_RECORD_HAS_NO_USER_TURN" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(resend).toHaveBeenCalledTimes(2);
  });

  it("accepts transcript evidence and cancels every later retry", async () => {
    const resend = vi.fn();
    const accept = vi.fn();
    const timers = scheduleSubmitRecovery({
      inspect: async () => ({ state: "accepted", turnId: "turn-1" }),
      resend,
      accept,
    }, [100, 300], 1_000);

    await vi.advanceTimersByTimeAsync(100);
    expect(accept).toHaveBeenCalledWith({ state: "accepted", turnId: "turn-1" });
    expect(resend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(accept).toHaveBeenCalledTimes(1);
    clearSubmitTimers(timers);
  });

  it("keeps unknown evidence pending instead of guessing or failing", async () => {
    const evidence: SubmitEvidence[] = [
      { state: "unknown", reason: "partial line" },
      { state: "unknown", reason: "partial line" },
      { state: "unknown", reason: "partial line" },
      { state: "accepted", turnId: "late-turn" },
    ];
    const accept = vi.fn();
    const unconfirmed = vi.fn();
    scheduleSubmitRecovery({
      inspect: async () => evidence.shift() ?? { state: "unknown" },
      resend: vi.fn(),
      accept,
      unconfirmed,
    }, [100, 300], 1_000, 500);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(unconfirmed).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(accept).toHaveBeenCalledWith({ state: "accepted", turnId: "late-turn" });
  });

  it("never schedules a retry outside the submit deadline", async () => {
    const resend = vi.fn();
    scheduleSubmitRecovery({
      inspect: async () => ({ state: "not-submitted" }),
      resend,
      accept: vi.fn(),
    }, [100, 5_000], 1_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resend).toHaveBeenCalledTimes(1);
  });

  it("uses limited exact normalization rather than fuzzy matching", () => {
    expect(sameSubmittedPrompt("one\r\ntwo\n", " one\ntwo ")).toBe(true);
    expect(sameSubmittedPrompt("one two", "one  two")).toBe(false);
    expect(sameSubmittedPrompt("prefix", "prefix suffix")).toBe(false);
  });

  it("keeps retries outside the normal hook response window", () => {
    expect(SUBMIT_RETRY_DELAYS_MS.every((delay) => delay > 0 && delay < SUBMIT_TIMEOUT_MS)).toBe(true);
    expect(Math.min(...SUBMIT_RETRY_DELAYS_MS)).toBeGreaterThanOrEqual(4_000);
  });
});
