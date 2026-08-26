import { describe, expect, it } from "vitest";
import { defaultAnswerFile, defaultPromptFile, defaultRuntime, defaultSession, isoNow, type TabBundle } from "../shared/schemas.js";
import { applyTabMessage } from "./tab-bundle-delta.js";

describe("tab bundle realtime deltas", () => {
  it("upserts prompt records without refetching answer history", () => {
    const bundle = fixture();
    const next = applyTabMessage(bundle, {
      type: "prompts.changed",
      delta: {
        revision: 1,
        updatedAt: "later",
        total: 1,
        upserts: [{ id: "p1", text: "hello", status: "pending", createdAt: "now", updatedAt: "now", origin: "queue", threadId: null, codexTurnId: null, clientUserMessageId: null, startedAt: null, completedAt: null, error: null, attempts: [] }],
        deletedIds: [],
      },
    });
    expect(next.needsSnapshot).toBe(false);
    expect(next.bundle.prompts.prompts[0].text).toBe("hello");
    expect(next.bundle.answers).toBe(bundle.answers);
  });

  it("requests one authoritative snapshot after a missed revision", () => {
    const result = applyTabMessage(fixture(), { type: "prompts.changed", delta: { revision: 3, updatedAt: "later", total: 0, upserts: [], deletedIds: [] } });
    expect(result).toMatchObject({ changed: false, needsSnapshot: true });
  });

  it("updates bounded totals without discarding already loaded history", () => {
    const bundle = fixture();
    bundle.window = { prompts: { start: 4, total: 5, completed: 4 }, answers: { start: 0, total: 0 } };
    const result = applyTabMessage(bundle, {
      type: "prompts.changed",
      delta: {
        revision: 1,
        updatedAt: "later",
        total: 6,
        completed: 5,
        upserts: [{ id: "p6", text: "new", status: "completed", createdAt: "now", updatedAt: "now", origin: "queue", threadId: "thread", codexTurnId: "turn", clientUserMessageId: null, startedAt: "now", completedAt: "later", error: null, attempts: [] }],
        deletedIds: [],
      },
    });
    expect(result.bundle.window?.prompts).toEqual({ start: 4, total: 6, completed: 5 });
    expect(result.bundle.prompts.prompts.map((prompt) => prompt.id)).toEqual(["p6"]);
  });
});

function fixture(): TabBundle {
  const now = isoNow();
  return {
    tab: { id: "tab", name: "tab", groupId: null, order: 0, createdAt: now, updatedAt: now, session: defaultSession(), layout: { leftWidthPercent: 42 } },
    prompts: defaultPromptFile(),
    answers: defaultAnswerFile(),
    runtime: defaultRuntime(),
  };
}
