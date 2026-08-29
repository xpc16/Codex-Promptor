import { describe, expect, it } from "vitest";
import { clampPromptComposerHeight, draggedPromptComposerHeight } from "./prompt-composer-resize.js";

describe("prompt composer top-edge resize", () => {
  it("grows upward and shrinks downward", () => {
    expect(draggedPromptComposerHeight(50, 300, 240, 1_000)).toBe(110);
    expect(draggedPromptComposerHeight(110, 240, 280, 1_000)).toBe(70);
  });

  it("keeps the existing minimum and viewport-aware maximum", () => {
    expect(clampPromptComposerHeight(10, 1_000)).toBe(50);
    expect(clampPromptComposerHeight(600, 1_000)).toBe(420);
    expect(clampPromptComposerHeight(300, 400)).toBe(180);
  });
});
