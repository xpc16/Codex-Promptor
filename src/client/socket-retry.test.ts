import { describe, expect, it } from "vitest";
import { createConnectionAlarm, FAILURES_BEFORE_ALERT, RECONNECT_MAX_MS, reconnectDelay } from "./socket-retry.js";

describe("connection alarm", () => {
  it("stays quiet through the drops a reconnect absorbs", () => {
    const alarm = createConnectionAlarm();
    for (let attempt = 1; attempt < FAILURES_BEFORE_ALERT; attempt += 1) {
      expect(alarm.noteFailure()).toBe(false);
    }
  });

  it("raises once when the reconnects have stopped working", () => {
    const alarm = createConnectionAlarm(3);
    expect([alarm.noteFailure(), alarm.noteFailure(), alarm.noteFailure()]).toEqual([false, false, true]);
    // One outage, one notice -- not one per retry.
    expect(alarm.noteFailure()).toBe(false);
    expect(alarm.noteFailure()).toBe(false);
  });

  it("rearms after a connection succeeds", () => {
    const alarm = createConnectionAlarm(2);
    alarm.noteFailure();
    alarm.noteFailure();
    alarm.noteSuccess();
    expect(alarm.failures()).toBe(0);
    expect(alarm.noteFailure()).toBe(false);
    expect(alarm.noteFailure()).toBe(true);
  });

  it("treats a single drop between successes as nothing to report", () => {
    const alarm = createConnectionAlarm(3);
    for (let cycle = 0; cycle < 10; cycle += 1) {
      expect(alarm.noteFailure()).toBe(false);
      alarm.noteSuccess();
    }
  });
});

describe("reconnect backoff", () => {
  it("retries quickly at first", () => {
    expect(reconnectDelay(1)).toBe(750);
    expect(reconnectDelay(2)).toBe(1_500);
    expect(reconnectDelay(3)).toBe(3_000);
  });

  it("gives a server that keeps refusing progressively more room", () => {
    expect(reconnectDelay(20)).toBe(RECONNECT_MAX_MS);
  });

  it("treats a zeroth attempt as the first", () => {
    expect(reconnectDelay(0)).toBe(750);
  });
});
