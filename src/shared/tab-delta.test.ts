import { describe, expect, it } from "vitest";
import { applyRecordDelta, buildRecordDelta, moveIsApplicable, singleMove } from "./tab-delta.js";

describe("record deltas", () => {
  it("upserts, deletes and preserves append order without sending a full order", () => {
    const before = [{ id: "a", value: 1 }, { id: "b", value: 2 }];
    const after = [{ id: "a", value: 3 }, { id: "b", value: 2 }, { id: "c", value: 4 }];
    const delta = buildRecordDelta(before, after, 2, "now");
    expect(delta).toMatchObject({ upserts: [{ id: "a", value: 3 }, { id: "c", value: 4 }], deletedIds: [] });
    expect(delta.order).toBeUndefined();
    expect(applyRecordDelta(before, delta)).toEqual(after);
  });

  it("carries an order only when surviving records moved", () => {
    const before = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const after = [{ id: "c" }, { id: "a" }];
    const delta = buildRecordDelta(before, after, 4, "now");
    expect(delta).toMatchObject({ deletedIds: ["b"], order: ["c", "a"] });
    expect(applyRecordDelta(before, delta)).toEqual(after);
  });
});

describe("single-record moves", () => {
  const ids = (records: readonly { id: string }[]) => records.map((record) => record.id);

  it("describes a dragged row as two ids instead of the whole order", () => {
    const before = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const after = [{ id: "a" }, { id: "c" }, { id: "d" }, { id: "b" }];
    const delta = buildRecordDelta(before, after, 2, "now");
    expect(delta.move).toEqual({ id: "b", beforeId: null });
    expect(delta.order).toBeUndefined();
    expect(ids(applyRecordDelta(before, delta))).toEqual(ids(after));
  });

  it("names the row the moved one now sits in front of", () => {
    const before = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const after = [{ id: "c" }, { id: "a" }, { id: "b" }];
    const delta = buildRecordDelta(before, after, 2, "now");
    expect(delta.move).toEqual({ id: "c", beforeId: "a" });
    expect(ids(applyRecordDelta(before, delta))).toEqual(ids(after));
  });

  it("falls back to the full order when more than one record moved", () => {
    const before = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const after = [{ id: "b" }, { id: "a" }, { id: "d" }, { id: "c" }];
    const delta = buildRecordDelta(before, after, 2, "now");
    expect(delta.move).toBeUndefined();
    expect(delta.order).toEqual(["b", "a", "d", "c"]);
    expect(ids(applyRecordDelta(before, delta))).toEqual(ids(after));
  });

  it("falls back to the full order when the move came with an edit", () => {
    const before = [{ id: "a", text: "1" }, { id: "b", text: "2" }];
    const after = [{ id: "b", text: "changed" }, { id: "a", text: "1" }];
    const delta = buildRecordDelta(before, after, 2, "now");
    expect(delta.move).toBeUndefined();
    expect(delta.order).toEqual(["b", "a"]);
  });

  it("reports no move when the order is untouched", () => {
    expect(singleMove(["a", "b"], ["a", "b"])).toBeNull();
    expect(singleMove(["a", "b"], ["a", "b", "c"])).toBeNull();
  });
});

describe("applying a move against a partial list", () => {
  const loaded = [{ id: "b" }, { id: "c" }];

  it("ignores a move of a record this window does not hold", () => {
    const move = { id: "a", beforeId: "c" };
    expect(moveIsApplicable(loaded, move)).toBe(true);
    expect(applyRecordDelta(loaded, { revision: 2, updatedAt: "now", total: 3, upserts: [], deletedIds: [], move }))
      .toEqual(loaded);
  });

  it("refuses a move whose anchor is outside this window", () => {
    expect(moveIsApplicable(loaded, { id: "b", beforeId: "a" })).toBe(false);
  });

  it("accepts a move to the end, which needs no anchor", () => {
    expect(moveIsApplicable(loaded, { id: "b", beforeId: null })).toBe(true);
  });
});
