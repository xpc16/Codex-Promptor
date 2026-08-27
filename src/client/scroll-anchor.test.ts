import { describe, expect, it } from "vitest";
import { BOTTOM_SLACK, isAtBottom, isNearTop, shouldHandoffWheel, wheelDeltaPixels } from "./scroll-anchor.js";

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

describe("nested prompt scrolling", () => {
  it("keeps the wheel inside while the prompt can still scroll that way", () => {
    const middle = { scrollTop: 80, scrollHeight: 300, clientHeight: 100 };
    expect(shouldHandoffWheel(middle, -40)).toBe(false);
    expect(shouldHandoffWheel(middle, 40)).toBe(false);
  });

  it("hands upward motion out only at the top", () => {
    expect(shouldHandoffWheel({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 }, -40)).toBe(true);
    expect(shouldHandoffWheel({ scrollTop: 0, scrollHeight: 300, clientHeight: 100 }, 40)).toBe(false);
  });

  it("hands downward motion out only at the bottom, allowing zoom rounding", () => {
    expect(shouldHandoffWheel({ scrollTop: 199.4, scrollHeight: 300, clientHeight: 100 }, 40)).toBe(true);
    expect(shouldHandoffWheel({ scrollTop: 199.4, scrollHeight: 300, clientHeight: 100 }, -40)).toBe(false);
  });

  it("hands either direction out when the prompt has no internal overflow", () => {
    const short = { scrollTop: 0, scrollHeight: 80, clientHeight: 100 };
    expect(shouldHandoffWheel(short, -40)).toBe(true);
    expect(shouldHandoffWheel(short, 40)).toBe(true);
  });

  it("converts line and page wheel units before moving the outer list", () => {
    expect(wheelDeltaPixels(3, 0, 20, 400)).toBe(3);
    expect(wheelDeltaPixels(3, 1, 20, 400)).toBe(60);
    expect(wheelDeltaPixels(-1, 2, 20, 400)).toBe(-400);
  });
});
