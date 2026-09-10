/**
 * A Codex thread id is only a durable pointer once Codex has written a rollout
 * for it, and Codex writes nothing until the first prompt lands. A thread that
 * `thread/start` has just created lives in the App Server's memory alone:
 * resuming it succeeds for as long as that process is up, and fails forever
 * after a restart -- `codex resume` exits 1 because no session exists on disk.
 *
 * Storing such an id as a tab's current thread is therefore a one-way loss.
 * Four tabs were found in that state; behind the pointer one of them replaced
 * sat 60 MB of conversation. The switch itself is legitimate -- the terminal
 * really is showing that new thread and the tab should follow it -- so the fix
 * is not to refuse the switch but to keep a way back.
 */

/**
 * Which thread the switch should record as the one being left.
 *
 * Normally that is simply the previous thread. But a chain of never-written
 * threads walks the only good pointer off the end: `d4 → d6 → d7` recorded
 * `d6` as the origin of the last hop, and `d6` had no rollout either, so `d4`
 * -- the thread holding the actual conversation -- became unreachable from the
 * tab that owned it. Leaving an undurable thread keeps the older origin.
 */
export function durableThreadOrigin(input: {
  /** The thread the tab is leaving. */
  previousThreadId: string;
  /** Whether that thread has a rollout on disk. */
  previousIsDurable: boolean;
  /** The origin recorded by the switch before this one, if any. */
  carriedFromThreadId: string | null;
}): string {
  if (input.previousIsDurable) return input.previousThreadId;
  return input.carriedFromThreadId ?? input.previousThreadId;
}

export type ResumeThreadChoice = {
  threadId: string;
  /** True when the stored thread was skipped for a known-good older one. */
  fellBack: boolean;
};

type RecoverySession = {
  threadId: string | null;
  lastDurableThreadId?: string | null;
  lastThreadSwitch?: { fromThreadId: string } | null;
};
export type ThreadDurabilityProbe = (threadId: string) => Promise<boolean>;

/** Shared by native hooks and App Server. Never let an empty switch erase
 * the last verified thread; a failed probe must not promote an unverified id.
 */
export async function rememberDurableThread(session: RecoverySession, targetId: string | null, probe: ThreadDurabilityProbe): Promise<string | null> {
  for (const id of new Set([targetId, session.threadId, session.lastDurableThreadId, session.lastThreadSwitch?.fromThreadId])) {
    if (id && await probe(id).catch(() => false)) return id;
  }
  return session.lastDurableThreadId ?? null;
}

/** Missing history permits recovery; permission/identity errors do not. The
 * normal path checks one header and never reads cache or full history.
 */
export async function resolveSavedCodexThread(session: RecoverySession, probe: ThreadDurabilityProbe, cachedId: () => Promise<string | null>): Promise<ResumeThreadChoice> {
  const checked = new Set<string>();
  const usable = async (id: string | null | undefined) => {
    if (!id || checked.has(id)) return false;
    checked.add(id);
    return probe(id);
  };
  for (const id of [session.threadId, session.lastDurableThreadId, session.lastThreadSwitch?.fromThreadId]) {
    if (await usable(id)) return { threadId: id!, fellBack: id !== session.threadId };
  }
  const cached = await cachedId();
  if (await usable(cached)) return { threadId: cached!, fellBack: cached !== session.threadId };
  throw new Error(`CODEX_SESSION_NOT_SAVED: No saved session found with ID ${session.threadId}. No verified history is available for this tab; choose a saved session to resume.`);
}

/** Older versions lost the durable origin after two empty thread switches.
 * Only accept this tab's own cache when its recorded prompts corroborate it.
 * The caller must still locate that exact id in Codex's sessions directory;
 * the cache's arbitrary file path is never used as proof of existence.
 */
export function cachedResumeThread(cache: unknown, prompts: readonly { threadId?: string | null }[]): string | null {
  const id = (cache as { threadId?: unknown } | null)?.threadId;
  if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
  return prompts.some((prompt) => prompt.threadId === id) ? id : null;
}
