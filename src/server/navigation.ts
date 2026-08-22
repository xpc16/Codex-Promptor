import { IndexFileSchema, isoNow, type IndexFile } from "../shared/schemas.js";

export type NavigationSection = { groupId: string | null; tabIds: string[] };

export function applyNavigationOrder(index: IndexFile, groupIds: string[], sections: NavigationSection[]): IndexFile {
  const currentGroupIds = index.groups.map((group) => group.id);
  if (!sameIdSet(groupIds, currentGroupIds)) throw new Error("GROUP_ORDER_INVALID");
  if (sections.length !== currentGroupIds.length + 1) throw new Error("NAVIGATION_SECTIONS_INVALID");

  const sectionKeys = sections.map((section) => section.groupId ?? "__ungrouped__");
  const expectedKeys = [...currentGroupIds, "__ungrouped__"];
  if (!sameIdSet(sectionKeys, expectedKeys)) throw new Error("NAVIGATION_SECTIONS_INVALID");

  const orderedTabIds = sections.flatMap((section) => section.tabIds);
  const currentTabIds = index.tabs.map((tab) => tab.id);
  if (!sameIdSet(orderedTabIds, currentTabIds)) throw new Error("TAB_ORDER_INVALID");

  const tabsById = new Map(index.tabs.map((tab) => [tab.id, tab]));
  const now = isoNow();
  const tabs = sections.flatMap((section) => section.tabIds.map((tabId, order) => ({
    ...tabsById.get(tabId)!,
    groupId: section.groupId,
    order,
    updatedAt: now,
  })));

  const groupsById = new Map(index.groups.map((group) => [group.id, group]));
  const groups = groupIds.map((groupId, order) => ({ ...groupsById.get(groupId)!, order }));
  return IndexFileSchema.parse({ ...index, groups, tabs });
}

export function deleteGroupAndUngroupTabs(index: IndexFile, groupId: string): IndexFile {
  if (!index.groups.some((group) => group.id === groupId)) throw new Error("GROUP_NOT_FOUND");
  const now = isoNow();
  const ungrouped = index.tabs.filter((tab) => tab.groupId === null).sort((a, b) => a.order - b.order);
  const moved = index.tabs.filter((tab) => tab.groupId === groupId).sort((a, b) => a.order - b.order);
  const movedById = new Map(moved.map((tab, offset) => [tab.id, {
    ...tab,
    groupId: null,
    order: ungrouped.length + offset,
    updatedAt: now,
  }]));
  const groups = index.groups
    .filter((group) => group.id !== groupId)
    .sort((a, b) => a.order - b.order)
    .map((group, order) => ({ ...group, order }));
  const tabs = index.tabs.map((tab) => movedById.get(tab.id) ?? tab);
  return IndexFileSchema.parse({ ...index, groups, tabs });
}

function sameIdSet(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length
    && new Set(actual).size === actual.length
    && actual.every((id) => expected.includes(id));
}
