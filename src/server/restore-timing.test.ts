import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRestoreTimings, createPhaseRecorder, formatDuration, formatRestoreTimings, type RestoreTrace } from "./restore-timing.js";

/** A clock the test advances by hand, so no phase is timed against real time. */
function clock() {
  let value = 0;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

describe("createPhaseRecorder", () => {
  it("times each step and the whole restore", async () => {
    const time = clock();
    const recorder = createPhaseRecorder(time.now);

    await recorder.step("appServer", async () => { time.advance(1_200); });
    time.advance(50); // work between steps still counts towards the total
    await recorder.step("resume", async () => { time.advance(6_700); });

    expect(recorder.phases()).toEqual([{ phase: "appServer", ms: 1_200 }, { phase: "resume", ms: 6_700 }]);
    expect(recorder.totalMs()).toBe(7_950);
  });

  it("times a step that throws, and lets the failure through", async () => {
    // A slow failure is the interesting kind: a 30s attach timeout has to show
    // up as 30 seconds, not vanish because the step never returned.
    const time = clock();
    const recorder = createPhaseRecorder(time.now);

    await expect(recorder.step("threadLoaded", async () => {
      time.advance(30_000);
      throw new Error("TUI_ATTACH_TIMEOUT");
    })).rejects.toThrow("TUI_ATTACH_TIMEOUT");

    expect(recorder.phases()).toEqual([{ phase: "threadLoaded", ms: 30_000 }]);
  });
});

describe("formatRestoreTimings", () => {
  const trace = (name: string, totalMs: number, ok = true): RestoreTrace => ({
    tabId: `id-${name}`,
    name,
    provider: "codex",
    ok,
    phases: [{ phase: "appServer", ms: 1_200 }, { phase: "history", ms: 800 }],
    totalMs,
  });

  it("puts the slowest conversation first and names the failures", () => {
    const lines = formatRestoreTimings([trace("快", 2_000), trace("慢", 18_400, false)], 20_000, 250);

    expect(lines[0]).toBe("Restore timings: 2 conversation(s) in 20.0s, launched 250ms apart");
    expect(lines[1]).toContain("慢");
    expect(lines[1]).toContain("appServer 1.2s · history 800ms");
    expect(lines[1]).toContain("[failed]");
    expect(lines[2]).toContain("快");
  });

  it("says nothing when nothing was restored", () => {
    expect(formatRestoreTimings([], 12, 250)).toEqual([]);
  });
});

describe("formatDuration", () => {
  it("keeps sub-second values readable as milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1_000)).toBe("1.0s");
    expect(formatDuration(18_449)).toBe("18.4s");
  });
});

describe("appendRestoreTimings", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), "promptor-timing-log-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  it("keeps earlier launches so two builds can be compared", async () => {
    // The first version of this printed to a console nobody kept, so the one
    // question it existed to answer still could not be checked afterwards.
    const file = path.join(root, "restore-timings.log");
    await appendRestoreTimings(file, ["first launch"]);
    await appendRestoreTimings(file, ["second launch", "  slow one"]);

    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines.filter((line) => !line.startsWith("["))).toEqual(["first launch", "second launch", "  slow one"]);
    expect(lines.filter((line) => line.startsWith("["))).toHaveLength(2);
  });

  it("writes nothing for a launch that restored nothing, and survives an unwritable path", async () => {
    const file = path.join(root, "restore-timings.log");
    await appendRestoreTimings(file, []);
    await expect(readFile(file, "utf8")).rejects.toThrow();
    // A diagnostic that cannot be written must never break a launch.
    await expect(appendRestoreTimings(path.join(root, "missing", "deep", "x.log"), ["line"])).resolves.toBeUndefined();
  });
});
