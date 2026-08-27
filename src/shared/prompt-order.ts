export function reorderPromptIds(ids: readonly string[], sourceId: string, targetId: string): string[] | null {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return null;
  const reordered = [...ids];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return reordered;
}

/**
 * Statuses a prompt cannot leave on its own: it ran, and the run is over.
 * Retrying moves a prompt back out of this set, which is why it is settled
 * rather than simply "not pending".
 */
const SETTLED: ReadonlySet<string> = new Set(["completed", "failed", "interrupted", "skipped"]);

/**
 * Puts the finished prompts in the order they actually finished.
 *
 * The list is stored in the order prompts were queued, and that is right for
 * the ones still waiting. It is wrong for the ones behind them: retrying a
 * failed prompt, or pushing one to the front of the queue, means a prompt can
 * finish long before or after its neighbours, and reading the history in
 * insertion order then tells the wrong story.
 *
 * Only the settled records move, and only into the slots settled records
 * already occupy. Everything else -- what is running, what is still queued and
 * in what order -- stays exactly where it was, so nothing here can disturb the
 * pending list that reordering validates against.
 */
export function sortSettledByCompletion<T extends { status: string; completedAt?: string | null }>(prompts: readonly T[]): T[] {
  const slots: number[] = [];
  const settled: T[] = [];
  prompts.forEach((prompt, index) => {
    if (!SETTLED.has(prompt.status)) return;
    slots.push(index);
    settled.push(prompt);
  });
  if (slots.length < 2) return [...prompts];
  const ranked = settled
    .map((prompt, index) => ({ prompt, index, epoch: completionEpoch(prompt) }))
    // A record with no completion time keeps its place relative to the rest
    // rather than being shoved to one end on the strength of a missing field.
    .sort((a, b) => (a.epoch === b.epoch ? a.index - b.index : a.epoch - b.epoch));
  const next = [...prompts];
  slots.forEach((slot, index) => { next[slot] = ranked[index].prompt; });
  return next;
}

function completionEpoch(prompt: { completedAt?: string | null }): number {
  const parsed = Date.parse(prompt.completedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
