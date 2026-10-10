import { beforeEach, describe, expect, it } from "vitest";
import {
  clampPromptComposerHeight,
  draggedPromptComposerHeight,
  forgetPromptComposerHeight,
  rememberPromptComposerHeight,
  rememberedPromptComposerHeight,
} from "./prompt-composer-resize.js";

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

describe("the height the composer was dragged to", () => {
  beforeEach(() => { forgetPromptComposerHeight(); });

  it("is nothing until something sets it", () => {
    expect(rememberedPromptComposerHeight(1_000)).toBeNull();
  });

  it("survives the remount that opening a conversation causes", () => {
    // The queue is keyed by thread, so connecting rebuilds it. Without this the
    // height set on a closed conversation was gone one click later.
    rememberPromptComposerHeight(260);
    expect(rememberedPromptComposerHeight(1_000)).toBe(260);
  });

  it("is clamped to whatever viewport reads it", () => {
    // Set on a desktop, read on a phone: 45% of a short viewport, not 260.
    rememberPromptComposerHeight(260);
    expect(rememberedPromptComposerHeight(400)).toBe(180);
  });
});
