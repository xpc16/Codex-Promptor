import { describe, expect, it } from "vitest";
import { applyIndexDelta, buildIndexDelta, indexDeltaIsEmpty } from "./index-delta.js";
import type { IndexFile, TabMeta } from "./schemas.js";

const tab = (id: string, name: string, order: number, updatedAt = "2026-08-28T00:00:00.000Z"): TabMeta => ({
  id,
  name,
  groupId: null,
  order,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt,
  session: {
    provider: "codex", state: "ready", reopenOnLaunch: true, workingDirectory: "D:\\work",
    threadId: `thread-${id}`, sessionId: `thread-${id}`, createdAt: "2026-08-01T00:00:00.000Z",
    connectedAt: "2026-08-01T00:00:00.000Z", lastError: null, lastThreadSwitch: null,
  },
  layout: { leftWidthPercent: 42 },
} as TabMeta);

const index = (revision: number, tabs: TabMeta[], overrides: Partial<IndexFile> = {}): IndexFile => ({
  schemaVersion: 1,
  revision,
  updatedAt: `2026-08-28T00:00:${String(revision).padStart(2, "0")}.000Z`,
  groups: [],
  tabs,
  ui: { consoleWidth: 300, theme: "light", locale: "zh-CN", ungroupedCollapsed: false, lastSelectedTabId: null },
  ...overrides,
});

describe("index delta", () => {
  it("carries only the tab that changed, not the whole navigation", () => {
    const before = index(7, [tab("a", "一", 0), tab("b", "二", 1), tab("c", "三", 2)]);
    const after = index(8, [tab("a", "一", 0), tab("b", "改名", 1, "2026-08-28T01:00:00.000Z"), tab("c", "三", 2)]);

    const delta = buildIndexDelta(before, after);

    expect(delta.tabs.upserts.map((t) => t.id)).toEqual(["b"]);
    expect(delta.tabs.deletedIds).toEqual([]);
    expect(delta.ui).toBeUndefined();
    // The point of the exercise: one renamed tab must not cost the other two.
    expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(after).length);
    expect(applyIndexDelta(before, delta)).toEqual(after);
  });

  it("expresses a reorder as the one tab that moved", () => {
    const before = index(1, [tab("a", "一", 0), tab("b", "二", 1), tab("c", "三", 2)]);
    const after = index(2, [tab("c", "三", 2), tab("a", "一", 0), tab("b", "二", 1)]);

    const delta = buildIndexDelta(before, after);

    expect(delta.tabs.move).toEqual({ id: "c", beforeId: "a" });
    expect(delta.tabs.upserts).toEqual([]);
    expect(applyIndexDelta(before, delta)!.tabs.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("refuses to apply against a revision the viewer is not holding", () => {
    const before = index(4, [tab("a", "一", 0)]);
    const after = index(5, [tab("a", "改", 0, "2026-08-28T02:00:00.000Z")]);
    const delta = buildIndexDelta(before, after);

    // Applying half a delta would leave the two sides silently disagreeing,
    // so the caller is told to ask for the whole index instead.
    expect(applyIndexDelta(index(3, [tab("a", "一", 0)]), delta)).toBeNull();
    expect(applyIndexDelta(before, delta)).toEqual(after);
  });

  it("carries the preferences block only when it changed", () => {
    const before = index(1, [tab("a", "一", 0)]);
    const sameUi = buildIndexDelta(before, index(2, [tab("a", "一", 0)]));
    expect(sameUi.ui).toBeUndefined();
    expect(indexDeltaIsEmpty(sameUi)).toBe(true);

    const themed = index(2, [tab("a", "一", 0)], { ui: { consoleWidth: 300, theme: "dark", locale: "zh-CN", ungroupedCollapsed: false, lastSelectedTabId: null } });
    const delta = buildIndexDelta(before, themed);
    expect(delta.ui).toMatchObject({ theme: "dark" });
    expect(indexDeltaIsEmpty(delta)).toBe(false);
    expect(applyIndexDelta(before, delta)!.ui.theme).toBe("dark");
  });

  it("handles a tab appearing and disappearing", () => {
    const before = index(1, [tab("a", "一", 0), tab("b", "二", 1)]);
    const after = index(2, [tab("a", "一", 0), tab("c", "三", 1)]);
    const delta = buildIndexDelta(before, after);

    expect(delta.tabs.upserts.map((t) => t.id)).toEqual(["c"]);
    expect(delta.tabs.deletedIds).toEqual(["b"]);
    expect(applyIndexDelta(before, delta)).toEqual(after);
  });
});
