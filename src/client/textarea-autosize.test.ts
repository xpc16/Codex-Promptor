import { describe, expect, it } from "vitest";
import { autoSizedHeight, autoSizedLines, PROMPT_ROW_MAX_LINES } from "./textarea-autosize.js";

const base = { lineHeight: 20, padding: 2, border: 0 };

describe("queue row height", () => {
  it("gives a one-line prompt one line", () => {
    expect(autoSizedHeight({ ...base, scrollHeight: 22 })).toBe(22);
  });

  it("grows with the prompt up to the cap", () => {
    expect(autoSizedHeight({ ...base, scrollHeight: 42 })).toBe(42);
    expect(autoSizedHeight({ ...base, scrollHeight: 62 })).toBe(62);
  });

  it("stops at the cap and leaves the rest to scroll inside the box", () => {
    expect(autoSizedHeight({ ...base, scrollHeight: 202 })).toBe(PROMPT_ROW_MAX_LINES * 20 + 2);
  });

  it("counts wrapped lines, not newlines -- the height is what was measured", () => {
    // One unbroken prompt that wrapped to five visual lines still fills the cap.
    expect(autoSizedHeight({ ...base, scrollHeight: 102 })).toBe(62);
  });

  it("includes padding and border because the box is border-box sized", () => {
    expect(autoSizedHeight({ scrollHeight: 34, lineHeight: 20, padding: 14, border: 2 })).toBe(36);
  });

  it("never collapses below a single line", () => {
    expect(autoSizedHeight({ ...base, scrollHeight: 0 })).toBe(22);
    expect(autoSizedHeight({ ...base, scrollHeight: 5 })).toBe(22);
  });

  it("honours a caller's own cap", () => {
    expect(autoSizedHeight({ ...base, scrollHeight: 202, maxLines: 1 })).toBe(22);
    expect(autoSizedHeight({ ...base, scrollHeight: 202, maxLines: 6 })).toBe(122);
  });

  it("falls back to the measured height when the line height is unreadable", () => {
    expect(autoSizedHeight({ scrollHeight: 80, lineHeight: Number.NaN, padding: 2, border: 2 })).toBe(82);
  });
});

describe("how many lines the row will show", () => {
  const metrics = (scrollHeight: number) => ({ scrollHeight, lineHeight: 20, padding: 2, border: 0 });

  it("tells the row apart from a wrapped one so its controls can move", () => {
    // The row stacks its edit and send buttons only from two lines up; at one
    // line there is no vertical room and they sit side by side.
    expect(autoSizedLines(metrics(22))).toBe(1);
    expect(autoSizedLines(metrics(42))).toBe(2);
    expect(autoSizedLines(metrics(62))).toBe(3);
  });

  it("stops at the cap however long the prompt is", () => {
    expect(autoSizedLines(metrics(2_000))).toBe(PROMPT_ROW_MAX_LINES);
  });

  it("stays at one line when the sheet gives no usable line height", () => {
    expect(autoSizedLines({ scrollHeight: 400, lineHeight: 0, padding: 0, border: 0 })).toBe(1);
  });

  it("agrees with the height it produces", () => {
    for (const height of [22, 42, 62, 400]) {
      expect(autoSizedHeight(metrics(height))).toBe(autoSizedLines(metrics(height)) * 20 + 2);
    }
  });
});
