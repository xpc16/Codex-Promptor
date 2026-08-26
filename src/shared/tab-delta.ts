import type { AnswerRecord, PromptRecord } from "./schemas.js";

export type RecordDelta<T extends { id: string }> = {
  revision: number;
  updatedAt: string;
  total: number;
  replace?: boolean;
  upserts: T[];
  deletedIds: string[];
  /** Present only when existing records were reordered. */
  order?: string[];
};

export type PromptDelta = RecordDelta<PromptRecord> & { completed?: number };
export type AnswerDelta = RecordDelta<AnswerRecord>;

export function buildRecordDelta<T extends { id: string }>(
  previous: readonly T[] | null,
  next: readonly T[],
  revision: number,
  updatedAt: string,
): RecordDelta<T> {
  if (!previous) {
    return { revision, updatedAt, total: next.length, replace: true, upserts: [...next], deletedIds: [], order: next.map((item) => item.id) };
  }
  const previousById = new Map(previous.map((item) => [item.id, item]));
  const nextById = new Map(next.map((item) => [item.id, item]));
  const upserts = next.filter((item) => {
    const before = previousById.get(item.id);
    return !before || JSON.stringify(before) !== JSON.stringify(item);
  });
  const deletedIds = previous.filter((item) => !nextById.has(item.id)).map((item) => item.id);
  const previousOrder = previous.map((item) => item.id);
  const nextOrder = next.map((item) => item.id);
  const existingNextOrder = nextOrder.filter((id) => previousById.has(id));
  const survivingPreviousOrder = previousOrder.filter((id) => nextById.has(id));
  const existingReordered = existingNextOrder.length !== survivingPreviousOrder.length
    || existingNextOrder.some((id, index) => id !== survivingPreviousOrder[index]);
  return {
    revision,
    updatedAt,
    total: next.length,
    upserts,
    deletedIds,
    ...(existingReordered ? { order: nextOrder } : {}),
  };
}

export function applyRecordDelta<T extends { id: string }>(current: readonly T[], delta: RecordDelta<T>): T[] {
  if (delta.replace) return orderRecords([...delta.upserts], delta.order);
  const deleted = new Set(delta.deletedIds);
  const next = current.filter((item) => !deleted.has(item.id));
  const indexById = new Map(next.map((item, index) => [item.id, index]));
  for (const item of delta.upserts) {
    const index = indexById.get(item.id);
    if (index === undefined) {
      indexById.set(item.id, next.length);
      next.push(item);
    } else {
      next[index] = item;
    }
  }
  return orderRecords(next, delta.order);
}

function orderRecords<T extends { id: string }>(records: T[], order?: readonly string[]): T[] {
  if (!order) return records;
  const ranks = new Map(order.map((id, index) => [id, index]));
  return records
    .map((item, index) => ({ item, index, rank: ranks.get(item.id) }))
    .sort((a, b) => a.rank === undefined && b.rank === undefined
      ? a.index - b.index
      : a.rank === undefined
        ? 1
        : b.rank === undefined
          ? -1
          : a.rank - b.rank)
    .map(({ item }) => item);
}
