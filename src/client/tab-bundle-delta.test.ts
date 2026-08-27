import { describe, expect, it } from "vitest";
import { defaultAnswerFile, defaultPromptFile, defaultRuntime, defaultSession, isoNow, type TabBundle } from "../shared/schemas.js";
import { applyTabMessage, retainEarlierRecords } from "./tab-bundle-delta.js";

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

  it("keeps scrolled-open history when a snapshot carries only the opening window", () => {
    const bundle = fixture();
    bundle.answers.answers = [answer("a1"), answer("a2"), answer("a3")];
    bundle.window = { prompts: { start: 0, total: 0, completed: 0 }, answers: { start: 0, total: 3 } };
    const snapshot = fixture();
    snapshot.answers.answers = [answer("a3")];
    snapshot.window = { prompts: { start: 0, total: 0, completed: 0 }, answers: { start: 2, total: 3 } };
    const result = applyTabMessage(bundle, { type: "snapshot", data: snapshot });
    expect(result.bundle.answers.answers.map((item) => item.id)).toEqual(["a1", "a2", "a3"]);
    expect(result.bundle.window?.answers).toEqual({ start: 0, total: 3 });
  });

  it("lets a snapshot replace history outright once the records no longer line up", () => {
    const bundle = fixture();
    bundle.answers.answers = [answer("a1"), answer("a2")];
    bundle.window = { prompts: { start: 0, total: 0, completed: 0 }, answers: { start: 0, total: 2 } };
    const snapshot = fixture();
    snapshot.answers.answers = [answer("b1")];
    snapshot.window = { prompts: { start: 0, total: 0, completed: 0 }, answers: { start: 0, total: 1 } };
    const result = applyTabMessage(bundle, { type: "snapshot", data: snapshot });
    expect(result.bundle.answers.answers.map((item) => item.id)).toEqual(["b1"]);
  });
});

describe("retaining earlier records", () => {
  const current = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("splices the two lists at the snapshot's first record", () => {
    expect(retainEarlierRecords(current, { start: 0, total: 3 }, [{ id: "c" }], { start: 2, total: 3 })).toEqual(current);
  });

  it("declines when the snapshot is not narrower than what is loaded", () => {
    expect(retainEarlierRecords(current, { start: 2, total: 3 }, [{ id: "c" }], { start: 2, total: 3 })).toBeNull();
  });

  it("declines when the gap between the two windows is not the overlap", () => {
    expect(retainEarlierRecords(current, { start: 0, total: 3 }, [{ id: "c" }], { start: 1, total: 3 })).toBeNull();
  });

  it("declines an empty or unrelated snapshot", () => {
    expect(retainEarlierRecords(current, { start: 0, total: 3 }, [], { start: 3, total: 3 })).toBeNull();
    expect(retainEarlierRecords(current, { start: 0, total: 3 }, [{ id: "z" }], { start: 2, total: 3 })).toBeNull();
  });

  it("declines when either side was read without a window", () => {
    expect(retainEarlierRecords(current, undefined, [{ id: "c" }], { start: 2, total: 3 })).toBeNull();
    expect(retainEarlierRecords(current, { start: 0, total: 3 }, [{ id: "c" }], undefined)).toBeNull();
  });
});

function answer(id: string) {
  const now = isoNow();
  return {
    id,
    promptId: `p-${id}`,
    threadId: "thread",
    codexTurnId: `turn-${id}`,
    clientUserMessageId: null,
    prompt: id,
    finalAnswer: id,
    status: "completed" as const,
    origin: "queue" as const,
    captureMode: "phase_final_answer" as const,
    error: null,
    startedAt: now,
    completedAt: now,
    recordedAt: now,
    metadata: {},
  };
}

function fixture(): TabBundle {
  const now = isoNow();
  return {
    tab: { id: "tab", name: "tab", groupId: null, order: 0, createdAt: now, updatedAt: now, session: defaultSession(), layout: { leftWidthPercent: 42 } },
    prompts: defaultPromptFile(),
    answers: defaultAnswerFile(),
    runtime: defaultRuntime(),
  };
}
