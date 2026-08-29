import type { TabMeta } from "../shared/schemas.js";

/**
 * How long to leave between launching one restore and the next.
 *
 * Not a concurrency cap. Restoring a conversation is almost entirely waiting --
 * a process spawn, an HTTP readiness poll, a 200ms thread-load poll, an RPC
 * round trip -- and waits overlap for free. Capping how many may wait at once
 * turned parallel waiting into sequential waiting and made the whole restore
 * take about as long as the sum of its parts instead of the longest one. What
 * a stagger does buy is the spawn storm: eight conversations firing three
 * processes each in the same instant is the spike that is worth spreading, and
 * it gives the conversation at the head of the plan a clear run at the machine.
 */
export const RESTORE_STAGGER_MS = 250;

/**
 * The order previously open conversations come back in.
 *
 * The tab that was selected when the app closed comes back first, then the rest
 * of its group -- conversations are grouped because they are worked on together
 * -- then everything else. Within each band the sidebar order is kept, so the
 * sequence is the one the reader can see.
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
  /** Resolves once every restore has settled. */
  done: Promise<void>;
  /** Moves a not-yet-launched conversation to the front. Anything already started is untouched. */
  promote(tabId: string): void;
};

/**
 * Launches the plan in order, spaced out, without ever making one restore wait
 * for another to finish.
 *
 * `promote` is what makes the stored selection safe to be wrong: a page that
 * opens and asks for a different conversation moves it to the front of what has
 * not launched yet rather than waiting behind a guess made when the app closed.
 */
export function runRestoreQueue(
  tabIds: readonly string[],
  staggerMs: number,
  run: (tabId: string) => Promise<void>,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
): RestoreQueue {
  const pending = [...tabIds];
  const started: Array<Promise<void>> = [];
  const launcher = (async () => {
    while (pending.length) {
      started.push(run(pending.shift()!).catch(() => undefined));
      if (pending.length && staggerMs > 0) await wait(staggerMs);
    }
  })();
  return {
    done: launcher.then(async () => { await Promise.all(started); }),
    promote: (tabId) => {
      const index = pending.indexOf(tabId);
      if (index > 0) pending.unshift(...pending.splice(index, 1));
    },
  };
}
