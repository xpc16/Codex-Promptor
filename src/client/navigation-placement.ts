import type { Group, TabMeta } from "../shared/schemas.js";

/** Return a complete, re-numbered group list with the source below the target. */
export function placeGroupAfter(groups: readonly Group[], sourceId: string, targetId: string): Group[] | null {
  if (sourceId === targetId) return null;
  const ordered = [...groups].sort((a, b) => a.order - b.order);
  const originalIds = ordered.map((group) => group.id);
  const source = ordered.findIndex((group) => group.id === sourceId);
  if (source < 0) return null;
  const [moved] = ordered.splice(source, 1);
  const target = ordered.findIndex((group) => group.id === targetId);
  if (target < 0) return null;
  ordered.splice(target + 1, 0, moved);
  if (ordered.every((group, order) => group.id === originalIds[order])) return null;
  return ordered.map((group, order) => ({ ...group, order }));
}

/**
 * A row target places the source below that row. A null target is a group
 * heading and places it first in that group.
 */
export function placeTab(
  tabs: readonly TabMeta[],
  groupIds: readonly string[],
  sourceId: string,
  targetId: string | null,
  groupId: string | null,
): TabMeta[] | null {
  const source = tabs.find((tab) => tab.id === sourceId);
  if (!source || targetId === sourceId && source.groupId === groupId) return null;
  const groupKeys: Array<string | null> = [...groupIds, null];
  const idsByGroup = new Map(groupKeys.map((key) => [key, orderedTabIds(tabs, key).filter((id) => id !== sourceId)]));
  const targetIds = idsByGroup.get(groupId);
  if (!targetIds) return null;
  const targetIndex = targetId ? targetIds.indexOf(targetId) : -1;
  if (targetId && targetIndex < 0) return null;
  targetIds.splice(targetId ? targetIndex + 1 : 0, 0, sourceId);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const next = groupKeys.flatMap((key) => (idsByGroup.get(key) ?? []).map((id, order) => ({ ...byId.get(id)!, groupId: key, order })));
  return next.every((tab) => {
    const current = byId.get(tab.id);
    return current?.groupId === tab.groupId && current.order === tab.order;
  }) ? null : next;
}

function orderedTabIds(tabs: readonly TabMeta[], groupId: string | null): string[] {
  return tabs.filter((tab) => tab.groupId === groupId).sort((a, b) => a.order - b.order).map((tab) => tab.id);
}
