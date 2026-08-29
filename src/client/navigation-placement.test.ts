import { describe, expect, it } from "vitest";
import { defaultSession, isoNow, type Group, type TabMeta } from "../shared/schemas.js";
import { placeGroupAfter, placeTab } from "./navigation-placement.js";

const tab = (id: string, groupId: string | null, order: number): TabMeta => ({
  id,
  name: id,
  groupId,
  order,
  createdAt: isoNow(),
  updatedAt: isoNow(),
  session: defaultSession(),
  layout: { leftWidthPercent: 42 },
});

describe("console drop placement", () => {
  it("places a conversation below the row it is dropped on", () => {
    const result = placeTab([tab("a", "g", 0), tab("b", "g", 1), tab("c", "g", 2)], ["g"], "a", "c", "g");
    expect(result?.filter((item) => item.groupId === "g").map((item) => item.id)).toEqual(["b", "c", "a"]);
  });

  it("places a conversation first when dropped on a group", () => {
    const result = placeTab([tab("a", "g1", 0), tab("b", "g2", 0), tab("c", "g2", 1)], ["g1", "g2"], "a", null, "g2");
    expect(result?.filter((item) => item.groupId === "g2").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("places a group below the target group", () => {
    const groups: Group[] = [
      { id: "a", name: "a", order: 0, collapsed: false },
      { id: "b", name: "b", order: 1, collapsed: false },
      { id: "c", name: "c", order: 2, collapsed: false },
    ];
    expect(placeGroupAfter(groups, "a", "c")?.map((group) => group.id)).toEqual(["b", "c", "a"]);
  });
});
