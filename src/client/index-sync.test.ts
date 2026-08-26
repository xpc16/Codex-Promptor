import { describe, expect, it } from "vitest";
import { dialogSurvivesIndex, nextSelectedTabId, shouldAdoptIndexRevision } from "./index-sync.js";

describe("navigation index reconciliation", () => {
  it("adopts newer revisions and re-applies the current one", () => {
    expect(shouldAdoptIndexRevision(8, 7)).toBe(true);
    expect(shouldAdoptIndexRevision(7, 7)).toBe(true);
    expect(shouldAdoptIndexRevision(0, -1)).toBe(true);
  });

  it("refuses a replayed or out-of-order push that would roll the sidebar back", () => {
    expect(shouldAdoptIndexRevision(6, 7)).toBe(false);
    expect(shouldAdoptIndexRevision(Number.NaN, 7)).toBe(false);
  });

  it("keeps the open conversation when it survived the change elsewhere", () => {
    expect(nextSelectedTabId("tab-2", ["tab-1", "tab-2"])).toBe("tab-2");
  });

  it("falls back to the first conversation when the open one was deleted elsewhere", () => {
    expect(nextSelectedTabId("tab-2", ["tab-1"])).toBe("tab-1");
    expect(nextSelectedTabId("tab-2", [])).toBeNull();
    expect(nextSelectedTabId(null, ["tab-9"])).toBe("tab-9");
  });

  it("keeps dialogs whose subject still exists", () => {
    expect(dialogSurvivesIndex({ kind: "group" }, [], [])).toBe(true);
    expect(dialogSurvivesIndex({ kind: "rename-tab", tabId: "t1" }, ["t1"], [])).toBe(true);
    expect(dialogSurvivesIndex({ kind: "delete-group", groupId: "g1" }, [], ["g1"])).toBe(true);
    expect(dialogSurvivesIndex(null, [], [])).toBe(true);
  });

  it("closes a dialog whose subject was removed by another viewer", () => {
    expect(dialogSurvivesIndex({ kind: "rename-tab", tabId: "t1" }, ["t2"], [])).toBe(false);
    expect(dialogSurvivesIndex({ kind: "delete-tab", tabId: "t1" }, [], [])).toBe(false);
    expect(dialogSurvivesIndex({ kind: "rename-group", groupId: "g1" }, [], ["g2"])).toBe(false);
  });
});
