import { describe, expect, it } from "vitest";
import { stalledMinutes } from "../shared/tab-activity.js";
import { decideStall, noteRolloutSize, TURN_STALL_MS } from "./turn-stall.js";

const NOW = Date.parse("2026-08-29T14:51:00.000Z");
const agoMs = (minutes: number) => NOW - minutes * 60_000;
const agoIso = (minutes: number) => new Date(agoMs(minutes)).toISOString();

describe("decideStall", () => {
  it("calls out a working turn whose rollout has gone quiet", () => {
    // The real case: task_started at 13:57, last rollout write at 13:59, and
    // nothing since -- no completion, no abort, no error.
    const decision = decideStall({ working: true, lastProgressAtMs: agoMs(52), stalledSince: null, nowMs: NOW });
    expect(decision).toEqual({ action: "mark", since: agoIso(52) });
  });

  it("dates it to the last progress there was, not to when it was noticed", () => {
    // The reader wants "no progress for 52 minutes", which is only true if the
    // mark carries the last write rather than the moment the sweep ran.
    const decision = decideStall({ working: true, lastProgressAtMs: agoMs(9), stalledSince: null, nowMs: NOW });
    expect(decision).toEqual({ action: "mark", since: agoIso(9) });
    expect(stalledMinutes(agoIso(9), NOW)).toBe(9);
  });

  it("leaves a turn alone while it is still recording", () => {
    expect(decideStall({ working: true, lastProgressAtMs: NOW - 11_000, stalledSince: null, nowMs: NOW }))
      .toEqual({ action: "none" });
    // Right up to the threshold, because a long command records nothing while
    // it runs and a warning at four minutes would be noise.
    expect(decideStall({ working: true, lastProgressAtMs: NOW - TURN_STALL_MS + 1, stalledSince: null, nowMs: NOW }))
      .toEqual({ action: "none" });
  });

  it("clears the mark as soon as anything is recorded again", () => {
    expect(decideStall({ working: true, lastProgressAtMs: NOW - 5_000, stalledSince: agoIso(52), nowMs: NOW }))
      .toEqual({ action: "clear" });
  });

  it("clears the mark when the turn ends, however the rollout looks", () => {
    expect(decideStall({ working: false, lastProgressAtMs: agoMs(52), stalledSince: agoIso(52), nowMs: NOW }))
      .toEqual({ action: "clear" });
    expect(decideStall({ working: false, lastProgressAtMs: agoMs(52), stalledSince: null, nowMs: NOW }))
      .toEqual({ action: "none" });
  });

  it("says nothing when the rollout cannot be read", () => {
    // An unfound rollout is not evidence of a stall. Treating it as one would
    // put a warning on every conversation whose file has not been located.
    expect(decideStall({ working: true, lastProgressAtMs: null, stalledSince: null, nowMs: NOW }))
      .toEqual({ action: "none" });
    expect(decideStall({ working: true, lastProgressAtMs: null, stalledSince: agoIso(52), nowMs: NOW }))
      .toEqual({ action: "clear" });
  });

  it("marks once and then stays quiet", () => {
    expect(decideStall({ working: true, lastProgressAtMs: agoMs(52), stalledSince: agoIso(52), nowMs: NOW }))
      .toEqual({ action: "none" });
  });
});

describe("stalledMinutes", () => {
  it("counts whole minutes and never goes backwards", () => {
    expect(stalledMinutes(agoIso(52), NOW)).toBe(52);
    expect(stalledMinutes(new Date(NOW + 5_000).toISOString(), NOW)).toBe(0);
    expect(stalledMinutes("not a date", NOW)).toBe(0);
  });
});

describe("noteRolloutSize", () => {
  it("counts growth as progress and starts the clock when it stops", () => {
    // The signal is the size, not the modification time: Windows leaves the
    // last-write time stale while Codex holds the rollout open, so one measured
    // here still said 05:02 fifty minutes after its last record at 05:51 and
    // made every long-lived conversation look stalled.
    const first = noteRolloutSize(undefined, 1_000, NOW - 120_000);
    expect(first).toEqual({ size: 1_000, seenAtMs: NOW - 120_000 });

    const grew = noteRolloutSize(first, 2_000, NOW - 60_000);
    expect(grew).toEqual({ size: 2_000, seenAtMs: NOW - 60_000 });

    // Unchanged size keeps the earlier timestamp, which is what makes the
    // elapsed time mean anything.
    expect(noteRolloutSize(grew, 2_000, NOW)).toBe(grew);
  });

  it("treats first sight as progress rather than as a stall already in progress", () => {
    // How long it had been quiet before this process started looking is not
    // knowable, so claiming a stall on the first sweep would be a guess.
    expect(noteRolloutSize(undefined, 5_000, NOW).seenAtMs).toBe(NOW);
    expect(decideStall({ working: true, lastProgressAtMs: NOW, stalledSince: null, nowMs: NOW }))
      .toEqual({ action: "none" });
  });

  it("notices a rollout that was replaced by a shorter one", () => {
    const before = noteRolloutSize(undefined, 9_000, NOW - 600_000);
    expect(noteRolloutSize(before, 40, NOW)).toEqual({ size: 40, seenAtMs: NOW });
  });
});
