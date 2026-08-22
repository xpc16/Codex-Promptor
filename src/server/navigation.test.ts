import { describe, expect, it } from "vitest";
import { defaultSession, IndexFileSchema, isoNow } from "../shared/schemas.js";
import { applyNavigationOrder, deleteGroupAndUngroupTabs } from "./navigation.js";

describe("console navigation ordering", () => {
  it("reorders groups and moves conversations across groups", () => {
    const now = isoNow();
    const index = IndexFileSchema.parse({
      schemaVersion: 1,
      revision: 0,
      updatedAt: now,
      groups: [
        { id: "g1", name: "第一组", order: 0, collapsed: false },
        { id: "g2", name: "第二组", order: 1, collapsed: false },
      ],
      tabs: [
        { id: "t1", name: "一", groupId: "g1", order: 0, createdAt: now, updatedAt: now, session: defaultSession() },
        { id: "t2", name: "二", groupId: "g1", order: 1, createdAt: now, updatedAt: now, session: defaultSession() },
        { id: "t3", name: "三", groupId: null, order: 0, createdAt: now, updatedAt: now, session: defaultSession() },
      ],
    });

    const result = applyNavigationOrder(index, ["g2", "g1"], [
      { groupId: "g2", tabIds: ["t2"] },
      { groupId: "g1", tabIds: ["t1"] },
      { groupId: null, tabIds: ["t3"] },
    ]);

    expect(result.groups.map((group) => group.id)).toEqual(["g2", "g1"]);
    expect(result.tabs.find((tab) => tab.id === "t2")).toMatchObject({ groupId: "g2", order: 0 });
  });

  it("rejects missing or duplicated navigation entries", () => {
    const index = IndexFileSchema.parse({ groups: [{ id: "g1", name: "组", order: 0 }], tabs: [] });
    expect(() => applyNavigationOrder(index, ["g1", "g1"], [{ groupId: "g1", tabIds: [] }, { groupId: null, tabIds: [] }])).toThrow("GROUP_ORDER_INVALID");
  });

  it("deletes a group and appends its conversations to ungrouped", () => {
    const now = isoNow();
    const index = IndexFileSchema.parse({
      groups: [
        { id: "g1", name: "待删除", order: 0 },
        { id: "g2", name: "保留", order: 1 },
      ],
      tabs: [
        { id: "u1", name: "未分组", groupId: null, order: 0, createdAt: now, updatedAt: now, session: defaultSession() },
        { id: "t2", name: "第二个", groupId: "g1", order: 1, createdAt: now, updatedAt: now, session: defaultSession() },
        { id: "t1", name: "第一个", groupId: "g1", order: 0, createdAt: now, updatedAt: now, session: defaultSession() },
      ],
    });

    const result = deleteGroupAndUngroupTabs(index, "g1");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ id: "g2", order: 0 });
    expect(result.tabs.filter((tab) => tab.groupId === null).sort((a, b) => a.order - b.order).map((tab) => tab.id)).toEqual(["u1", "t1", "t2"]);
    expect(() => deleteGroupAndUngroupTabs(index, "missing")).toThrow("GROUP_NOT_FOUND");
  });
});
