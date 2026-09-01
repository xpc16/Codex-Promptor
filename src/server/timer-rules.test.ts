import { describe, expect, it } from "vitest";
import { normalizeTimerRule, nextTimerRunAt, TimerRuleError } from "./timer-rules.js";

describe("timer rules", () => {
  it("normalizes an interval and coalesces missed occurrences", () => {
    const anchor = new Date(2026, 7, 20, 0, 0);
    const now = new Date(2026, 7, 27, 1, 0);
    const result = normalizeTimerRule({
      kind: "interval",
      every: 6,
      unit: "hours",
      anchorAt: anchor.toISOString(),
      endAt: null,
    }, now);

    expect(result.schedule).toEqual({
      kind: "interval",
      every: 6,
      unit: "hours",
      anchorAt: localDateTime(anchor),
      endAt: null,
    });
    expect(result.nextRunAt).toBe(new Date(2026, 7, 27, 6, 0).toISOString());
  });

  it("returns the following interval when now is exactly an occurrence", () => {
    expect(nextTimerRunAt({
      kind: "interval",
      every: 1,
      unit: "hours",
      anchorAt: "2026-08-27T00:00",
      endAt: null,
    }, new Date(2026, 7, 27, 3, 0))).toBe(new Date(2026, 7, 27, 4, 0).toISOString());
  });

  it("stores two decimal places and rounds fractional hours to whole minutes", () => {
    const anchor = new Date(2026, 7, 27, 0, 0);
    const result = normalizeTimerRule({
      kind: "interval",
      every: 0.106,
      unit: "hours",
      anchorAt: localDateTime(anchor),
      endAt: null,
    }, anchor);

    expect(result.schedule).toMatchObject({ kind: "interval", every: 0.11 });
    expect(result.nextRunAt).toBe(new Date(2026, 7, 27, 0, 7).toISOString());
  });

  it("rejects an interval that becomes zero after keeping two decimals", () => {
    expect(() => normalizeTimerRule({
      kind: "interval",
      every: 0.004,
      unit: "days",
      anchorAt: "2026-08-27T00:00",
      endAt: null,
    })).toThrow(TimerRuleError);
  });

  it("honours an inclusive interval end", () => {
    const schedule = {
      kind: "interval" as const,
      every: 1,
      unit: "hours" as const,
      anchorAt: "2026-08-27T00:00",
      endAt: "2026-08-27T02:00",
    };
    expect(nextTimerRunAt(schedule, new Date(2026, 7, 27, 1, 0))).toBe(new Date(2026, 7, 27, 2, 0).toISOString());
    expect(nextTimerRunAt(schedule, new Date(2026, 7, 27, 2, 0))).toBeNull();
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

  it("keeps a daily interval on the same host-local clock time across DST", () => {
    const priorTimeZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      const next = nextTimerRunAt({
        kind: "interval",
        every: 1,
        unit: "days",
        anchorAt: "2026-03-07T09:00",
        endAt: null,
      }, new Date("2026-03-07T15:00:00.000Z"));
      expect(next).toBe("2026-03-08T13:00:00.000Z");
      expect(new Date(next!).getHours()).toBe(9);
    } finally {
      if (priorTimeZone === undefined) delete process.env.TZ;
      else process.env.TZ = priorTimeZone;
    }
  });
});

function localMinute(offset: number, base = new Date()): string {
  const value = new Date(base.getTime() + offset);
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}`;
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}`;
}

function localDateTime(value: Date): string {
  return `${localDate(value)}T${two(value.getHours())}:${two(value.getMinutes())}`;
}

function two(value: number): string { return String(value).padStart(2, "0"); }
