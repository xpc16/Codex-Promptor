import { describe, expect, it } from "vitest";
import { unwrapClaudePastedContent } from "./claude-pasted-content.js";

describe("Claude terminal paste envelope", () => {
  it("removes only a complete matching envelope", () => {
    expect(unwrapClaudePastedContent('\n\n<pasted_content id="5865">\nfirst\nsecond\n</pasted_content id="5865">\n')).toBe("first\nsecond");
    expect(unwrapClaudePastedContent('<pasted_content id="5865">\nfirst\n</pasted_content id="9999">')).toContain("<pasted_content");
    expect(unwrapClaudePastedContent('prefix\n<pasted_content id="5865">\nfirst\n</pasted_content id="5865">')).toContain("prefix");
    expect(unwrapClaudePastedContent("first\nsecond")).toBe("first\nsecond");
  });
});
