import { describe, expect, it } from "vitest";
import { reorderPromptIds, sortSettledByCompletion } from "./prompt-order.js";

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

describe("finished prompts read in the order they finished", () => {
  const prompt = (id: string, status: string, completedAt: string | null) => ({ id, status, completedAt });

  it("orders settled records by completion time", () => {
    const list = [
      prompt("a", "completed", "2026-08-27T10:00:03Z"),
      prompt("b", "completed", "2026-08-27T10:00:01Z"),
      prompt("c", "completed", "2026-08-27T10:00:02Z"),
    ];
    expect(sortSettledByCompletion(list).map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("leaves running and pending records exactly where they are", () => {
    const list = [
      prompt("done-late", "completed", "2026-08-27T10:00:09Z"),
      prompt("running", "running", null),
      prompt("done-early", "completed", "2026-08-27T10:00:01Z"),
      prompt("queued-1", "pending", null),
      prompt("queued-2", "pending", null),
    ];
    // The two settled records swap; the slots they occupy do not move, so the
    // pending list the reorder route validates against is untouched.
    expect(sortSettledByCompletion(list).map((item) => item.id))
      .toEqual(["done-early", "running", "done-late", "queued-1", "queued-2"]);
  });

  it("sorts every settled status together, not just completions", () => {
    const list = [
      prompt("skipped", "skipped", "2026-08-27T10:00:04Z"),
      prompt("failed", "failed", "2026-08-27T10:00:02Z"),
      prompt("interrupted", "interrupted", "2026-08-27T10:00:03Z"),
    ];
    expect(sortSettledByCompletion(list).map((item) => item.id)).toEqual(["failed", "interrupted", "skipped"]);
  });

  it("keeps a record with no completion time in its relative place at the end", () => {
    const list = [
      prompt("unstamped", "completed", null),
      prompt("late", "completed", "2026-08-27T10:00:05Z"),
      prompt("early", "completed", "2026-08-27T10:00:01Z"),
    ];
    expect(sortSettledByCompletion(list).map((item) => item.id)).toEqual(["early", "late", "unstamped"]);
  });

  it("returns a copy and does nothing when there is nothing to order", () => {
    const list = [prompt("only", "completed", "2026-08-27T10:00:01Z"), prompt("queued", "pending", null)];
    const sorted = sortSettledByCompletion(list);
    expect(sorted).not.toBe(list);
    expect(sorted.map((item) => item.id)).toEqual(["only", "queued"]);
  });
});
