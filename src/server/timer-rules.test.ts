import { describe, expect, it } from "vitest";
import { normalizeTimerRule, nextTimerRunAt, TimerRuleError } from "./timer-rules.js";

describe("timer rules", () => {
  it("normalizes an interval and coalesces missed occurrences", () => {
    const result = normalizeTimerRule({
      kind: "interval",
      every: 6,
      unit: "hours",
      anchorAt: "2026-08-20T00:00:00Z",
      endAt: null,
    }, new Date("2026-08-27T01:00:00Z"));

    expect(result.schedule).toEqual({
      kind: "interval",
      every: 6,
      unit: "hours",
      anchorAt: "2026-08-20T00:00:00.000Z",
      endAt: null,
    });
    expect(result.nextRunAt).toBe("2026-08-27T06:00:00.000Z");
  });

  it("returns the following interval when now is exactly an occurrence", () => {
    expect(nextTimerRunAt({
      kind: "interval",
      every: 1,
      unit: "hours",
      anchorAt: "2026-08-27T00:00:00.000Z",
      endAt: null,
    }, new Date("2026-08-27T03:00:00.000Z"))).toBe("2026-08-27T04:00:00.000Z");
  });

  it("honours an inclusive interval end", () => {
    const schedule = {
      kind: "interval" as const,
      every: 1,
      unit: "hours" as const,
      anchorAt: "2026-08-27T00:00:00.000Z",
      endAt: "2026-08-27T02:00:00.000Z",
    };
    expect(nextTimerRunAt(schedule, new Date("2026-08-27T01:00:00.000Z"))).toBe("2026-08-27T02:00:00.000Z");
    expect(nextTimerRunAt(schedule, new Date("2026-08-27T02:00:00.000Z"))).toBeNull();
  });

  it("rejects a past one-time schedule when saving", () => {
    const past = localMinute(-60_000);
    expect(() => normalizeTimerRule({ kind: "once", localDateTime: past }, new Date(), { rejectPastOnce: true }))
      .toThrow(TimerRuleError);
  });

  it("calculates a future local one-time schedule", () => {
    const now = new Date();
    const local = localMinute(2 * 60_000, now);
    const result = normalizeTimerRule({ kind: "once", localDateTime: local }, now, { rejectPastOnce: true });
    expect(result.nextRunAt).not.toBeNull();
    expect(new Date(result.nextRunAt!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("sorts and deduplicates weekly days and finds a future occurrence", () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
    const day = tomorrow.getDay() === 0 ? 7 : tomorrow.getDay();
    const result = normalizeTimerRule({
      kind: "weekly",
      daysOfWeek: [day, day],
      localTime: "23:59",
      startDate: localDate(tomorrow),
      endDate: localDate(tomorrow),
    }, now);
    expect(result.schedule.kind === "weekly" && result.schedule.daysOfWeek).toEqual([day]);
    expect(result.nextRunAt).not.toBeNull();
  });

  it("rejects malformed calendar and range values", () => {
    expect(() => normalizeTimerRule({ kind: "once", localDateTime: "2026-02-30T10:00" }))
      .toThrow(TimerRuleError);
    expect(() => normalizeTimerRule({
      kind: "weekly",
      daysOfWeek: [1],
      localTime: "09:00",
      startDate: "2026-09-02",
      endDate: "2026-09-01",
    })).toThrow(TimerRuleError);
  });
});

function localMinute(offset: number, base = new Date()): string {
  const value = new Date(base.getTime() + offset);
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}`;
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}`;
}

function two(value: number): string { return String(value).padStart(2, "0"); }
