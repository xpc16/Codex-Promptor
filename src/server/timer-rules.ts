import {
  TimerScheduleSchema,
  type TimerSchedule,
} from "../shared/schemas.js";

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME = /^(\d{2}):(\d{2})$/;
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export class TimerRuleError extends Error {
  readonly code = "INVALID_TIMER_SCHEDULE";
  constructor(message: string) {
    super(message);
    this.name = "TimerRuleError";
  }
}

export type NormalizedTimerRule = {
  schedule: TimerSchedule;
  nextRunAt: string | null;
};

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Validate a timer rule and calculate its first occurrence strictly after
 * `now`. Local schedules intentionally use the host Date implementation's
 * compatible DST behaviour; interval schedules are fixed UTC durations.
 */
export function normalizeTimerRule(
  value: unknown,
  now = new Date(),
  options: { rejectPastOnce?: boolean } = {},
): NormalizedTimerRule {
  const schedule = TimerScheduleSchema.parse(value);
  assertValidDate(now, "Current time is invalid.");

  if (schedule.kind === "once") {
    const occurrence = localDateTime(schedule.localDateTime);
    if (options.rejectPastOnce && occurrence.getTime() <= now.getTime()) {
      throw new TimerRuleError("The one-time schedule must be in the future.");
    }
    return {
      schedule: { kind: "once", localDateTime: schedule.localDateTime },
      nextRunAt: occurrence.getTime() > now.getTime() ? occurrence.toISOString() : null,
    };
  }

  if (schedule.kind === "weekly") {
    const [hour, minute] = parseLocalTime(schedule.localTime);
    const start = schedule.startDate === null ? null : parseLocalDate(schedule.startDate);
    const end = schedule.endDate === null ? null : parseLocalDate(schedule.endDate);
    if (start && end && compareDateParts(start, end) > 0) {
      throw new TimerRuleError("The weekly end date must not precede its start date.");
    }
    const daysOfWeek = [...new Set(schedule.daysOfWeek)].sort((a, b) => a - b);
    if (daysOfWeek.length === 0) throw new TimerRuleError("Select at least one weekday.");
    const normalized: TimerSchedule = {
      ...schedule,
      daysOfWeek,
      localTime: two(hour) + ":" + two(minute),
    };
    return { schedule: normalized, nextRunAt: nextWeeklyRun(normalized, now) };
  }

  const anchor = isoDate(schedule.anchorAt, "The interval anchor must be an ISO UTC timestamp.");
  const end = schedule.endAt === null ? null : isoDate(schedule.endAt, "The interval end must be an ISO UTC timestamp.");
  const step = schedule.every * (schedule.unit === "hours" ? HOUR_MS : DAY_MS);
  if (!Number.isSafeInteger(step) || step <= 0) throw new TimerRuleError("The interval is too large.");
  if (end && end.getTime() < anchor.getTime()) {
    throw new TimerRuleError("The interval end must not precede its anchor.");
  }
  const normalized: TimerSchedule = {
    ...schedule,
    anchorAt: anchor.toISOString(),
    endAt: end?.toISOString() ?? null,
  };
  return { schedule: normalized, nextRunAt: nextIntervalRun(normalized, now) };
}

/** Advance any rule to the first occurrence strictly later than `now`. */
export function nextTimerRunAt(schedule: TimerSchedule, now = new Date()): string | null {
  return normalizeTimerRule(schedule, now).nextRunAt;
}

function nextWeeklyRun(schedule: Extract<TimerSchedule, { kind: "weekly" }>, now: Date): string | null {
  const [hour, minute] = parseLocalTime(schedule.localTime);
  const start = schedule.startDate === null ? null : parseLocalDate(schedule.startDate);
  const end = schedule.endDate === null ? null : parseLocalDate(schedule.endDate);
  const today: DateParts = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  let cursor = start && compareDateParts(start, today) > 0 ? start : today;

  // A matching weekday occurs within seven days. Fourteen leaves room for a
  // DST-normalized candidate to fall on the wrong side of `now`.
  for (let offset = 0; offset < 14; offset += 1) {
    const day = addLocalDays(cursor, offset);
    if (end && compareDateParts(day, end) > 0) return null;
    const candidate = new Date(day.year, day.month - 1, day.day, hour, minute, 0, 0);
    const weekDay = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (schedule.daysOfWeek.includes(weekDay) && candidate.getTime() > now.getTime()) {
      return candidate.toISOString();
    }
  }
  return null;
}

function nextIntervalRun(schedule: Extract<TimerSchedule, { kind: "interval" }>, now: Date): string | null {
  const anchor = isoDate(schedule.anchorAt, "Invalid interval anchor.").getTime();
  const end = schedule.endAt === null ? null : isoDate(schedule.endAt, "Invalid interval end.").getTime();
  const step = schedule.every * (schedule.unit === "hours" ? HOUR_MS : DAY_MS);
  const elapsed = now.getTime() - anchor;
  const occurrence = elapsed < 0 ? anchor : anchor + (Math.floor(elapsed / step) + 1) * step;
  if (!Number.isFinite(occurrence) || (end !== null && occurrence > end)) return null;
  return new Date(occurrence).toISOString();
}

function localDateTime(value: string): Date {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) throw new TimerRuleError("Use YYYY-MM-DDTHH:mm for a one-time schedule.");
  const parts = checkedDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (hour > 23 || minute > 59) throw new TimerRuleError("The local time is invalid.");
  return new Date(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0);
}

function parseLocalTime(value: string): [number, number] {
  const match = LOCAL_TIME.exec(value);
  if (!match) throw new TimerRuleError("Use HH:mm for a weekly time.");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new TimerRuleError("The weekly time is invalid.");
  return [hour, minute];
}

type DateParts = { year: number; month: number; day: number };

function parseLocalDate(value: string): DateParts {
  const match = LOCAL_DATE.exec(value);
  if (!match) throw new TimerRuleError("Use YYYY-MM-DD for weekly date bounds.");
  return checkedDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

function checkedDateParts(year: number, month: number, day: number): DateParts {
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new TimerRuleError("The local calendar date is invalid.");
  }
  return { year, month, day };
}

function addLocalDays(value: DateParts, count: number): DateParts {
  const date = new Date(value.year, value.month - 1, value.day + count, 12, 0, 0, 0);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function compareDateParts(left: DateParts, right: DateParts): number {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

function isoDate(value: string, message: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !/Z$/.test(value)) throw new TimerRuleError(message);
  return date;
}

function assertValidDate(value: Date, message: string): void {
  if (!Number.isFinite(value.getTime())) throw new TimerRuleError(message);
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}
