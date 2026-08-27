import { describe, expect, it } from "vitest";
import { INITIAL_ANSWER_WINDOW, MAX_WINDOW_RECORDS, retainedWindowLimit, tailWindowStart } from "./tab-window.js";

describe("tail window start", () => {
  it("keeps only the newest records when nothing is pinned", () => {
    expect(tailWindowStart(119, INITIAL_ANSWER_WINDOW)).toBe(116);
    expect(tailWindowStart(2, INITIAL_ANSWER_WINDOW)).toBe(0);
  });

  it("stretches backwards to keep a pinned record inside the window", () => {
    expect(tailWindowStart(100, 3, [40])).toBe(40);
    expect(tailWindowStart(100, 3, [-1, 98])).toBe(97);
  });

  it("never lets a pinned record open an unbounded read", () => {
    expect(tailWindowStart(2_000, 3, [0])).toBe(2_000 - MAX_WINDOW_RECORDS);
  });

  it("treats an unusable limit as one record", () => {
    expect(tailWindowStart(10, Number.NaN)).toBe(9);
    expect(tailWindowStart(10, 0)).toBe(9);
  });
});

describe("retained window limit", () => {
  it("asks for as much as the reader has already scrolled open", () => {
    expect(retainedWindowLimit(80, 120, INITIAL_ANSWER_WINDOW)).toBe(40);
  });

  it("never drops below the opening window", () => {
    expect(retainedWindowLimit(120, 120, INITIAL_ANSWER_WINDOW)).toBe(INITIAL_ANSWER_WINDOW);
  });

  it("stays inside the read ceiling", () => {
    expect(retainedWindowLimit(0, 5_000, INITIAL_ANSWER_WINDOW)).toBe(MAX_WINDOW_RECORDS);
  });
});
