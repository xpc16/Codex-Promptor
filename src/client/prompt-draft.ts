import type { AgentProvider } from "../shared/schemas.js";

/**
 * A prompt typed but not yet queued is unsaved work, and it used to live only
 * in React state -- switching conversations unmounts the queue, so the text was
 * thrown away silently. It is kept here instead, per conversation, for as long
 * as the page lives.
 *
 * Deliberately in memory only. A draft is unsent text: it should not be written
 * to browser storage on disk, and it never goes to the server until the user
 * actually adds it to the list. Switching panes or conversations keeps it;
 * reloading the page does not, which is the intended lifetime.
 */
export type DraftStore = {
  get(tabId: string): string;
  set(tabId: string, text: string): void;
};

/** Long enough for any real prompt, short enough to bound what one page holds. */
export const MAX_DRAFT_LENGTH = 200_000;

export function createDraftStore(): DraftStore {
  const drafts = new Map<string, string>();
  return {
    get: (tabId) => drafts.get(tabId) ?? "",
    set: (tabId, text) => {
      // An abandoned draft is dropped rather than stored, so opening many
      // conversations does not leave an entry behind for every one of them.
      if (!text.trim()) drafts.delete(tabId);
      else drafts.set(tabId, text.slice(0, MAX_DRAFT_LENGTH));
    },
  };
}

/** The store backing the composer for this page. */
const pageDrafts = createDraftStore();

export type SessionFormDraft = {
  provider: AgentProvider;
  mode: "new" | "resume";
  workingDirectory: string;
  resumeId: string;
};

export type SessionFormDraftStore = Map<string, SessionFormDraft>;

/** Setup fields have the same lifetime as a composer draft: this page only. */
export function createSessionFormDraftStore(): SessionFormDraftStore {
  return new Map();
}

const pageSessionFormDrafts = createSessionFormDraftStore();

export function readSessionFormDraft(
  tabId: string,
  fallback: SessionFormDraft,
  store: SessionFormDraftStore = pageSessionFormDrafts,
): SessionFormDraft {
  return tabId && store.has(tabId) ? { ...store.get(tabId)! } : { ...fallback };
}

export function writeSessionFormDraft(
  tabId: string,
  draft: SessionFormDraft,
  store: SessionFormDraftStore = pageSessionFormDrafts,
): void {
  if (!tabId) return;
  store.set(tabId, {
    ...draft,
    workingDirectory: draft.workingDirectory.slice(0, 2_048),
    resumeId: draft.resumeId.slice(0, 512),
  });
}

export function readPromptDraft(tabId: string, store: DraftStore = pageDrafts): string {
  return tabId ? store.get(tabId) : "";
}

export function writePromptDraft(tabId: string, text: string, store: DraftStore = pageDrafts): void {
  if (tabId) store.set(tabId, text);
}

export function clearPromptDraft(tabId: string, store: DraftStore = pageDrafts): void {
  writePromptDraft(tabId, "", store);
}
