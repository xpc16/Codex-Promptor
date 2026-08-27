import { describe, expect, it } from "vitest";
import { BOTTOM_SLACK, isAtBottom, isNearTop } from "./scroll-anchor.js";

const at = (scrollTop: number) => ({ scrollTop, scrollHeight: 1_000, clientHeight: 400 });

describe("following new content", () => {
  it("follows when the reader is at the bottom", () => {
    expect(isAtBottom(at(600))).toBe(true);
  });

  it("follows through a few pixels of slack", () => {
    expect(isAtBottom(at(600 - BOTTOM_SLACK))).toBe(true);
  });

  it("stays put once the reader has scrolled up to read something", () => {
    expect(isAtBottom(at(200))).toBe(false);
    expect(isAtBottom(at(0))).toBe(false);
  });

  it("keeps following a list too short to scroll", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });

  it("follows rather than freezing when the measurements are unusable", () => {
    expect(isAtBottom({ scrollTop: Number.NaN, scrollHeight: 1_000, clientHeight: 400 })).toBe(true);
  });
});

describe("asking for the previous page", () => {
  it("triggers only near the very top", () => {
    expect(isNearTop({ scrollTop: 0 })).toBe(true);
    expect(isNearTop({ scrollTop: 48 })).toBe(true);
    expect(isNearTop({ scrollTop: 49 })).toBe(false);
    expect(isNearTop({ scrollTop: 600 })).toBe(false);
  });
});
