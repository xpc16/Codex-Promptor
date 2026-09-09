import { describe, expect, it } from "vitest";
import type { TabBundle } from "../shared/schemas.js";
import { changedSnapshotSections, snapshotTags } from "./snapshot-sections.js";

const bundle = (overrides: Partial<TabBundle> = {}): TabBundle => ({
  tab: { id: "t1", name: "对话", session: { provider: "codex", state: "ready" } } as never,
  prompts: { revision: 4, prompts: [{ id: "p1", text: "第一条" }] } as never,
  answers: { revision: 2, answers: [{ id: "a1", finalAnswer: "回答" }] } as never,
  runtime: { revision: 9, runner: { state: "paused" } } as never,
  window: { prompts: { start: 0, total: 1, completed: 0 }, answers: { start: 0, total: 1 } },
  ...overrides,
});

describe("what a reconnecting page is sent back", () => {
  it("nothing at all, when it holds every section", () => {
    const current = bundle();
    expect(changedSnapshotSections(current, snapshotTags(current), snapshotTags(current))).toBeNull();
  });

  it("only the section that moved, which is usually the smallest one", () => {
    // `runtime` changes on almost every event and is 2% of a bundle's bytes.
    // Under one hash over the whole thing, that cost 24 kB to deliver 455.
    const held = bundle();
    const current = bundle({ runtime: { revision: 10, runner: { state: "running" } } as never });
    const changed = changedSnapshotSections(current, snapshotTags(current), snapshotTags(held));
    expect(Object.keys(changed!).sort()).toEqual(["runtime", "window"]);
    expect(changed!.runtime).toEqual(current.runtime);
  });

  it("carries the window with whatever moved, because it is derived from it", () => {
    const held = bundle();
    const current = bundle({ prompts: { revision: 5, prompts: [] } as never });
    const changed = changedSnapshotSections(current, snapshotTags(current), snapshotTags(held));
    expect(changed!.window).toEqual(current.window);
  });

  it("every section, when the page claims nothing", () => {
    const current = bundle();
    const changed = changedSnapshotSections(current, snapshotTags(current), undefined);
    expect(Object.keys(changed!).sort()).toEqual(["answers", "prompts", "runtime", "tab", "window"]);
  });

  it("every section, when the page claims something this version cannot read", () => {
    // An older page sent one hash for the whole bundle rather than four. That
    // reads as holding nothing, which is exactly what it got before this
    // existed -- not an error, and not a stale merge.
    const current = bundle();
    for (const held of ["a-single-whole-bundle-hash", 42, null, []]) {
      expect(Object.keys(changedSnapshotSections(current, snapshotTags(current), held)!)).toContain("prompts");
    }
  });

  it("tells sections apart rather than hashing the bundle once", () => {
    // The whole point: two bundles that differ only in runtime must produce
    // three matching tags, not four differing ones.
    const before = snapshotTags(bundle());
    const after = snapshotTags(bundle({ runtime: { revision: 10, runner: { state: "running" } } as never }));
    expect(after.tab).toBe(before.tab);
    expect(after.prompts).toBe(before.prompts);
    expect(after.answers).toBe(before.answers);
    expect(after.runtime).not.toBe(before.runtime);
  });
});
