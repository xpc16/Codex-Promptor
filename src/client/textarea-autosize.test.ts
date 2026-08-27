import { describe, expect, it } from "vitest";
import { autoSizedHeight, PROMPT_ROW_MAX_LINES } from "./textarea-autosize.js";

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
