import type { TabMeta } from "../shared/schemas.js";

/** How many conversations come back at once. Each one is several processes and a rollout read. */
export const RESTORE_CONCURRENCY = 2;

/**
 * The order previously open conversations come back in.
 *
 * Restoring them all at once meant the one you were about to look at competed
 * with seven you were not. The tab that was selected when the app closed comes
 * back first, then the rest of its group -- conversations are grouped because
 * they are worked on together -- then everything else. Within each band the
 * sidebar order is kept, so the sequence is the one the reader can see.
 */
export function restoreOrder(
  tabs: readonly TabMeta[],
  candidateIds: readonly string[],
  selectedTabId: string | null,
): string[] {
  const candidates = new Set(candidateIds);
  const ordered = tabs.filter((tab) => candidates.has(tab.id));
  const selected = ordered.find((tab) => tab.id === selectedTabId) ?? null;
  const rest = ordered.filter((tab) => tab !== selected);
  const ranked = selected
    ? [selected, ...rest.filter((tab) => tab.groupId === selected.groupId), ...rest.filter((tab) => tab.groupId !== selected.groupId)]
    : rest;
  const planned = ranked.map((tab) => tab.id);
  // A candidate the index no longer lists still has to be attempted; dropping
  // it here would silently stop restoring it.
  const seen = new Set(planned);
  return [...planned, ...candidateIds.filter((tabId) => !seen.has(tabId))];
}

export type RestoreQueue = {
  /** Resolves once every task has settled. */
  done: Promise<void>;
  /** Moves a queued id to the front. A task already running or finished is untouched. */
  promote(tabId: string): void;
};

/**
 * Runs the plan a few at a time, and lets it be re-pointed while it drains.
 *
 * `promote` is what makes the stored selection safe to be wrong: a page that
 * opens and asks for a different conversation moves it to the front of what is
 * left rather than waiting behind a guess made when the app last closed.
 */
export function runRestoreQueue(
  tabIds: readonly string[],
  limit: number,
  run: (tabId: string) => Promise<void>,
): RestoreQueue {
  const pending = [...tabIds];
  const width = Math.max(1, limit);
  let active = 0;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => { settle = resolve; });
  const pump = (): void => {
    while (active < width && pending.length) {
      const tabId = pending.shift()!;
      active += 1;
      void run(tabId).catch(() => undefined).then(() => { active -= 1; pump(); });
    }
    if (!pending.length && active === 0) settle();
  };
  pump();
  return {
    done,
    promote: (tabId) => {
      const index = pending.indexOf(tabId);
      if (index > 0) pending.unshift(...pending.splice(index, 1));
    },
  };
}
