import { describe, expect, it } from "vitest";
import { applyRecordDelta, buildRecordDelta } from "./tab-delta.js";

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

