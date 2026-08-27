import { describe, expect, it } from "vitest";
import { insertCommonPrompt } from "./prompt-insertion.js";

describe("common prompt insertion", () => {
  it("inserts at a caret and replaces an active selection", () => {
    expect(insertCommonPrompt("before after", "X", { start: 7, end: 7, version: 2 }, 2)).toEqual({ value: "before Xafter", cursor: 8 });
    expect(insertCommonPrompt("before after", "X", { start: 7, end: 12, version: 2 }, 2)).toEqual({ value: "before X", cursor: 8 });
  });

  it("appends safely when the selection is stale or invalid", () => {
    expect(insertCommonPrompt("changed", "template", { start: 0, end: 3, version: 1 }, 2)).toEqual({ value: "changed\n\ntemplate", cursor: 17 });
    expect(insertCommonPrompt("draft\n", "template", { start: 8, end: 9, version: 2 }, 2)).toEqual({ value: "draft\ntemplate", cursor: 14 });
  });
});
