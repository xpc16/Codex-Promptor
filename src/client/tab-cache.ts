import type { TabBundle } from "../shared/schemas.js";
import { INITIAL_ANSWER_WINDOW, INITIAL_PROMPT_WINDOW, retainedWindowLimit } from "../shared/tab-window.js";

/**
 * What this browser already holds for a conversation.
 *
 * Only two tab views stay mounted, so switching away used to throw the loaded
 * records out and fetch them again on the way back. This keeps them for the
 * life of the page: re-selecting a conversation paints from here immediately
 * and the refetch behind it is a revalidation the server answers with a 304.
 *
 * `promptLimit` / `answerLimit` remember how far back the reader has scrolled,
 * so a reload asks for that same depth instead of collapsing the view to the
 * opening few records and making them page back through it a second time.
 */
export type CachedTab = { bundle: TabBundle; promptLimit: number; answerLimit: number };

export const MAX_CACHED_TABS = 8;

export type TabCache = {
  get(tabId: string): CachedTab | null;
  remember(bundle: TabBundle): CachedTab;
  forget(tabId: string): void;
  retain(validIds: ReadonlySet<string>): void;
  size(): number;
};

export function windowLimits(bundle: TabBundle): { promptLimit: number; answerLimit: number } {
  const promptWindow = bundle.window?.prompts;
  const answerWindow = bundle.window?.answers;
  return {
    promptLimit: promptWindow
      ? retainedWindowLimit(promptWindow.start, promptWindow.total, INITIAL_PROMPT_WINDOW)
      : INITIAL_PROMPT_WINDOW,
    answerLimit: answerWindow
      ? retainedWindowLimit(answerWindow.start, answerWindow.total, INITIAL_ANSWER_WINDOW)
      : INITIAL_ANSWER_WINDOW,
  };
}

export function createTabCache(limit = MAX_CACHED_TABS): TabCache {
  const entries = new Map<string, CachedTab>();
  const touch = (tabId: string, entry: CachedTab) => {
    entries.delete(tabId);
    entries.set(tabId, entry);
    while (entries.size > Math.max(1, limit)) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  };
  return {
    get(tabId) {
      const entry = entries.get(tabId);
      if (!entry) return null;
      touch(tabId, entry);
      return entry;
    },
    remember(bundle) {
      const entry: CachedTab = { bundle, ...windowLimits(bundle) };
      touch(bundle.tab.id, entry);
      return entry;
    },
    forget(tabId) { entries.delete(tabId); },
    retain(validIds) {
      for (const tabId of [...entries.keys()]) if (!validIds.has(tabId)) entries.delete(tabId);
    },
    size() { return entries.size; },
  };
}

const pageCache = createTabCache();

export function readCachedTab(tabId: string, cache: TabCache = pageCache): CachedTab | null { return cache.get(tabId); }
export function rememberTab(bundle: TabBundle, cache: TabCache = pageCache): void { cache.remember(bundle); }
export function forgetCachedTab(tabId: string, cache: TabCache = pageCache): void { cache.forget(tabId); }
export function retainCachedTabs(validIds: ReadonlySet<string>, cache: TabCache = pageCache): void { cache.retain(validIds); }
