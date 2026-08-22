import { describe, expect, it } from "vitest";
import { reorderPromptIds } from "./prompt-order.js";

describe("prompt ordering", () => {
  it("moves an item using explicit drag source and target ids", () => {
    expect(reorderPromptIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderPromptIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("does not create an order for missing or identical ids", () => {
    expect(reorderPromptIds(["a", "b"], "a", "a")).toBeNull();
    expect(reorderPromptIds(["a", "b"], "missing", "b")).toBeNull();
  });
});
