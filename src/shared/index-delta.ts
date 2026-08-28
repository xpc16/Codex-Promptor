import type { Group, IndexFile, TabMeta } from "./schemas.js";
import { applyRecordDelta, buildRecordDelta, type RecordDelta } from "./tab-delta.js";

/**
 * What changed in the navigation index, rather than the whole index again.
 *
 * Every viewer holds the same index, so any change to it is broadcast to all
 * of them. The file carries every tab's metadata, so one tab's `updatedAt`
 * moving used to resend all of them: measured at 13.5KB a time, 88 times an
 * hour, which was 10% of everything that crossed the tunnel.
 *
 * Tabs and groups are already id-bearing records in a stable order, which is
 * exactly what the queue's delta protocol was built for, so this reuses it
 * rather than inventing a second one.
 */
export type IndexDelta = {
  /** The revision the receiver must already be holding; otherwise this cannot be applied. */
  from: number;
  revision: number;
  updatedAt: string;
  tabs: RecordDelta<TabMeta>;
  groups: RecordDelta<Group>;
  /** Carried only when it changed. It is small, and it changes almost never. */
  ui?: IndexFile["ui"];
};

export function buildIndexDelta(previous: IndexFile, next: IndexFile): IndexDelta {
  const uiChanged = JSON.stringify(previous.ui) !== JSON.stringify(next.ui);
  return {
    from: previous.revision,
    revision: next.revision,
    updatedAt: next.updatedAt,
    tabs: buildRecordDelta(previous.tabs, next.tabs, next.revision, next.updatedAt),
    groups: buildRecordDelta(previous.groups, next.groups, next.revision, next.updatedAt),
    ...(uiChanged ? { ui: next.ui } : {}),
  };
}

/**
 * Null when the receiver is not holding `from`. A delta against a revision the
 * viewer never saw would silently produce a different index on each side, so
 * the caller asks for the whole thing instead.
 */
export function applyIndexDelta(current: IndexFile, delta: IndexDelta): IndexFile | null {
  if (!delta || typeof delta !== "object") return null;
  if (!Number.isFinite(delta.from) || current.revision !== delta.from) return null;
  return {
    ...current,
    revision: delta.revision,
    updatedAt: delta.updatedAt,
    tabs: applyRecordDelta(current.tabs, delta.tabs),
    groups: applyRecordDelta(current.groups, delta.groups),
    ui: delta.ui ?? current.ui,
  };
}

/** Whether a delta carries nothing, which happens when a write did not change what viewers show. */
export function indexDeltaIsEmpty(delta: IndexDelta): boolean {
  const quiet = (record: RecordDelta<{ id: string }>) =>
    !record.replace && record.upserts.length === 0 && record.deletedIds.length === 0 && !record.order && !record.move;
  return quiet(delta.tabs) && quiet(delta.groups) && delta.ui === undefined;
}
