import { describe, expect, it } from "vitest";
import { RuntimeFileSchema } from "./schemas.js";
import { applyRuntimeDelta, buildRuntimeDelta, runtimeDeltaIsEmpty } from "./runtime-delta.js";

const runtime = (revision: number, over: Record<string, unknown> = {}) =>
  RuntimeFileSchema.parse({ revision, ...over });

describe("what changed in a tab's runtime", () => {
  it("carries only the sections that moved", () => {
    // The whole document used to go out for any change: 580 bytes a message,
    // while what actually moved was one field of one section.
    const previous = runtime(7);
    const next = runtime(8, { runner: { ...previous.runner, state: "running" } });
    const delta = buildRuntimeDelta(previous, next);
    expect(delta).toMatchObject({ from: 7, revision: 8 });
    expect(delta.runner?.state).toBe("running");
    expect(delta.terminal).toBeUndefined();
    expect(delta.reconciliation).toBeUndefined();
    expect(delta.queueConfig).toBeUndefined();
  });

  it("carries every section that moved together", () => {
    const previous = runtime(1);
    const next = runtime(2, {
      runner: { ...previous.runner, state: "running" },
      terminal: { ...previous.terminal, state: "running", cols: 120, rows: 30 },
    });
    const delta = buildRuntimeDelta(previous, next);
    expect(delta.runner).toBeDefined();
    expect(delta.terminal?.cols).toBe(120);
    expect(delta.queueConfig).toBeUndefined();
  });

  it("says so when a write moved nothing viewers hold", () => {
    expect(runtimeDeltaIsEmpty(buildRuntimeDelta(runtime(3), runtime(4)))).toBe(true);
    expect(runtimeDeltaIsEmpty(buildRuntimeDelta(runtime(3), runtime(4, { queueConfig: { onFailure: "continue" } })))).toBe(false);
  });
});

describe("applying a runtime delta", () => {
  it("moves the named sections and leaves the rest standing", () => {
    const current = runtime(7, { queueConfig: { onFailure: "continue" } });
    const next = applyRuntimeDelta(current, buildRuntimeDelta(current, runtime(8, {
      queueConfig: { onFailure: "continue" },
      terminal: { ...current.terminal, state: "exited", lastExitCode: 1 },
    })));
    expect(next?.revision).toBe(8);
    expect(next?.terminal.lastExitCode).toBe(1);
    expect(next?.queueConfig.onFailure).toBe("continue");
    expect(next?.runner).toEqual(current.runner);
  });

  it("refuses a delta against a revision this side never saw", () => {
    // Applying it halfway would leave the two sides quietly disagreeing; the
    // caller asks for the whole runtime instead.
    const delta = buildRuntimeDelta(runtime(7), runtime(8, { runner: { ...runtime(7).runner, state: "running" } }));
    expect(applyRuntimeDelta(runtime(6), delta)).toBeNull();
    expect(applyRuntimeDelta(runtime(8), delta)).toBeNull();
    expect(applyRuntimeDelta(runtime(7), { ...delta, from: Number.NaN })).toBeNull();
  });

  it("round-trips a change through build and apply", () => {
    const previous = runtime(11);
    const next = runtime(12, {
      runner: { ...previous.runner, state: "running", activePromptId: "p1" },
      reconciliation: { required: true, lastCompletedAt: null },
    });
    expect(applyRuntimeDelta(previous, buildRuntimeDelta(previous, next))).toEqual(next);
  });
});
