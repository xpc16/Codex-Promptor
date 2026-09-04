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

/**
 * Which thread a reopen should actually resume.
 *
 * Falling back is deliberately conservative: it happens only when the stored
 * thread is known to have no rollout *and* the recorded origin is known to
 * have one. A lookup that merely failed to find a file is not enough to
 * override what the tab says, so anything less certain resumes the stored id
 * and lets the launch report its own error.
 */
export function chooseResumeThread(input: {
  threadId: string;
  fallbackThreadId: string | null;
  threadHasRollout: boolean;
  fallbackHasRollout: boolean;
}): ResumeThreadChoice {
  if (input.threadHasRollout) return { threadId: input.threadId, fellBack: false };
  if (input.fallbackThreadId && input.fallbackThreadId !== input.threadId && input.fallbackHasRollout) {
    return { threadId: input.fallbackThreadId, fellBack: true };
  }
  return { threadId: input.threadId, fellBack: false };
}
