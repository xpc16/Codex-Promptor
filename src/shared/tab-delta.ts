import type { AnswerRecord, PromptRecord } from "./schemas.js";

/** One record changed position: put `id` immediately before `beforeId`, or last. */
export type RecordMove = { id: string; beforeId: string | null };

export type RecordDelta<T extends { id: string }> = {
  revision: number;
  updatedAt: string;
  total: number;
  replace?: boolean;
  upserts: T[];
  deletedIds: string[];
  /** Present only when existing records were reordered in a way `move` cannot express. */
  order?: string[];
  /**
   * A dragged queue row moves exactly one record and changes no content, so
   * naming the record and its new neighbour says everything the full order
   * would -- in two ids rather than one per row in the conversation.
   */
  move?: RecordMove;
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
  // A pure reposition -- same records, same contents, one of them somewhere
  // else -- is the drag case, and it compresses to two ids.
  const move = existingReordered && upserts.length === 0 && deletedIds.length === 0
    ? singleMove(previousOrder, nextOrder)
    : null;
  return {
    revision,
    updatedAt,
    total: next.length,
    upserts,
    deletedIds,
    ...(move ? { move } : existingReordered ? { order: nextOrder } : {}),
  };
}

/**
 * The one record whose removal makes the two orders identical, if there is one.
 * The candidate sits at the first position where the orders diverge: it is the
 * new occupant when the record moved earlier, and the displaced one when it
 * moved later.
 */
export function singleMove(before: readonly string[], after: readonly string[]): RecordMove | null {
  if (before.length !== after.length) return null;
  let divergence = 0;
  while (divergence < before.length && before[divergence] === after[divergence]) divergence += 1;
  if (divergence === before.length) return null;
  for (const candidate of new Set([after[divergence], before[divergence]])) {
    const withoutBefore = before.filter((id) => id !== candidate);
    const withoutAfter = after.filter((id) => id !== candidate);
    if (withoutBefore.length !== withoutAfter.length) continue;
    if (withoutBefore.some((id, index) => id !== withoutAfter[index])) continue;
    const index = after.indexOf(candidate);
    return { id: candidate, beforeId: index + 1 < after.length ? after[index + 1] : null };
  }
  return null;
}

/**
 * Whether a move can be carried out against the records this client holds.
 *
 * A record outside the loaded window has no rendered position, so its move is
 * a no-op rather than a problem. A move whose anchor is missing while the
 * record itself is present cannot be placed, and the caller must resynchronise
 * instead of guessing.
 */
export function moveIsApplicable<T extends { id: string }>(current: readonly T[], move: RecordMove | undefined): boolean {
  if (!move) return true;
  if (!current.some((item) => item.id === move.id)) return true;
  return move.beforeId === null || current.some((item) => item.id === move.beforeId);
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
  return delta.move ? applyMove(next, delta.move) : orderRecords(next, delta.order);
}

function applyMove<T extends { id: string }>(records: T[], move: RecordMove): T[] {
  const from = records.findIndex((item) => item.id === move.id);
  if (from < 0) return records;
  const rest = [...records.slice(0, from), ...records.slice(from + 1)];
  if (move.beforeId === null) return [...rest, records[from]];
  const to = rest.findIndex((item) => item.id === move.beforeId);
  if (to < 0) return records;
  rest.splice(to, 0, records[from]);
  return rest;
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
