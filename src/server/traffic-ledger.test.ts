import { describe, expect, it } from "vitest";
import { createTrafficLedger, OVERFLOW_KEY, trafficKey } from "./traffic-ledger.js";

const T0 = Date.parse("2026-08-27T10:00:00.000Z");
const minute = 60_000;

describe("traffic keys", () => {
  it("names direction, channel and kind", () => {
    expect(trafficKey("out", "ws", "terminal.screen")).toBe("out:ws:terminal.screen");
    expect(trafficKey("in", "http", "POST /api/tabs/:tabId/prompts 200")).toBe("in:http:POST /api/tabs/:tabId/prompts 200");
  });

  it("normalises whitespace and refuses to grow without bound", () => {
    expect(trafficKey("out", "ws", "  a\n b  ")).toBe("out:ws:a b");
    expect(trafficKey("out", "ws", "x".repeat(500)).length).toBeLessThan(140);
    expect(trafficKey("out", "ws", "")).toBe("out:ws:unknown");
  });
});

describe("recording", () => {
  it("accumulates count, bytes and the largest single message", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "terminal.screen", 100, { rawBytes: 100, at: T0 });
    ledger.record("out", "ws", "terminal.screen", 900, { rawBytes: 900, at: T0 });
    const entry = ledger.rollup({ at: T0 }).entries["out:ws:terminal.screen"];
    expect(entry).toMatchObject({ count: 2, bytes: 1_000, max: 900 });
  });

  it("keeps the pre-compression size so the ratio is visible", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "http", "GET /api/tabs/:tabId 200", 1_200, { rawBytes: 8_000, at: T0 });
    const entry = ledger.rollup({ at: T0 }).entries["out:http:GET /api/tabs/:tabId 200"];
    expect(entry).toMatchObject({ bytes: 1_200, rawBytes: 8_000 });
  });

  it("treats a missing raw size as uncompressed", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "prompts.changed", 400, { at: T0 });
    expect(ledger.rollup({ at: T0 }).entries["out:ws:prompts.changed"]).toMatchObject({ bytes: 400, rawBytes: 400 });
  });

  it("folds unexpected kinds into one key instead of growing forever", () => {
    const ledger = createTrafficLedger({ maxKeys: 8 });
    for (let index = 0; index < 40; index += 1) ledger.record("out", "ws", `kind-${index}`, 10, { rawBytes: 10, at: T0 });
    const keys = Object.keys(ledger.rollup({ at: T0 }).entries);
    expect(keys.length).toBe(9);
    expect(keys).toContain(trafficKey("out", "ws", OVERFLOW_KEY));
  });
});

describe("buckets", () => {
  it("separates traffic by minute", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "terminal.screen", 100, { rawBytes: 100, at: T0 });
    ledger.record("out", "ws", "terminal.screen", 100, { rawBytes: 100, at: T0 + minute });
    expect(ledger.buckets().map((bucket) => bucket.startedAt)).toEqual([
      "2026-08-27T10:00:00.000Z",
      "2026-08-27T10:01:00.000Z",
    ]);
  });

  it("drains only buckets that are complete, and only once", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "a", 10, { rawBytes: 10, at: T0 });
    ledger.record("out", "ws", "b", 10, { rawBytes: 10, at: T0 + minute });

    const first = ledger.drain(T0 + minute + 5_000);
    expect(first.map((bucket) => bucket.startedAt)).toEqual(["2026-08-27T10:00:00.000Z"]);
    // The minute still filling is not handed out, and a second drain of the
    // same instant repeats nothing.
    expect(ledger.drain(T0 + minute + 5_000)).toEqual([]);

    const second = ledger.drain(T0 + 2 * minute);
    expect(second.map((bucket) => bucket.startedAt)).toEqual(["2026-08-27T10:01:00.000Z"]);
  });

  it("keeps drained buckets in the readable window", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "a", 250, { rawBytes: 250, at: T0 });
    ledger.drain(T0 + minute);
    expect(ledger.rollup({ at: T0 + minute }).totals.bytes).toBe(250);
  });

  it("drops the oldest once the window is full", () => {
    const ledger = createTrafficLedger({ retainedBuckets: 3 });
    for (let index = 0; index < 6; index += 1) ledger.record("out", "ws", "a", 10, { rawBytes: 10, at: T0 + index * minute });
    expect(ledger.buckets()).toHaveLength(3);
    expect(ledger.buckets()[0].startedAt).toBe("2026-08-27T10:03:00.000Z");
  });
});

describe("rollup", () => {
  it("reports rates over the buckets that exist, not since boot", () => {
    const ledger = createTrafficLedger();
    // Two minutes of data: 120 messages, 12,000 bytes.
    for (let index = 0; index < 120; index += 1) {
      ledger.record("out", "ws", "terminal.screen", 100, { rawBytes: 100, at: T0 + (index % 2) * minute });
    }
    const entry = ledger.rollup({ at: T0 + minute }).entries["out:ws:terminal.screen"];
    expect(entry.perMinute).toBe(60);
    expect(entry.bytesPerSecond).toBe(100);
  });

  it("honours a since window", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "old", 1_000, { rawBytes: 1_000, at: T0 });
    ledger.record("out", "ws", "new", 10, { rawBytes: 10, at: T0 + 10 * minute });
    const recent = ledger.rollup({ sinceMs: 5 * minute, at: T0 + 10 * minute });
    expect(Object.keys(recent.entries)).toEqual(["out:ws:new"]);
  });

  it("sorts by bytes so the expensive kinds come first", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "small", 10, { rawBytes: 10, at: T0 });
    ledger.record("out", "ws", "large", 9_000, { rawBytes: 9_000, at: T0 });
    ledger.record("out", "ws", "medium", 500, { rawBytes: 500, at: T0 });
    expect(Object.keys(ledger.rollup({ at: T0 }).entries)).toEqual([
      "out:ws:large",
      "out:ws:medium",
      "out:ws:small",
    ]);
  });

  it("is empty and safe before anything is recorded", () => {
    const rollup = createTrafficLedger().rollup();
    expect(rollup).toMatchObject({ from: null, to: null, entries: {} });
    expect(rollup.totals).toEqual({ count: 0, bytes: 0, rawBytes: 0, max: 0 });
  });

  it("forgets everything on reset", () => {
    const ledger = createTrafficLedger();
    ledger.record("out", "ws", "a", 100, { rawBytes: 100, at: T0 });
    ledger.reset();
    expect(ledger.rollup({ at: T0 }).totals.bytes).toBe(0);
  });
});
