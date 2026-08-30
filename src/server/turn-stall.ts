/**
 * Noticing when a turn has stopped making progress.
 *
 * Codex can leave a turn running with nothing behind it. Observed on a 110MB
 * thread: the model started a PowerShell command in a background cell, polled
 * `wait` on it every eleven seconds at 156k input tokens a poll, and then
 * simply stopped being called. No task_complete, no turn_aborted, no error --
 * the rollout just ends. waitForTurn's deadline is twenty-four hours, so the
 * queue sat on "running" and the only symptom was a spinner that never moved.
 *
 * The signal is the rollout's last write, not our own notification traffic.
 * Completion notifications can be routed to the interactive TUI client instead
 * of this one (see waitForTurn), so quiet notifications prove nothing, while
 * the rollout is written by Codex whichever client it is talking to.
 *
 * This only reports. A single long command legitimately records nothing while
 * it runs, and deciding a turn is dead is the reader's call, not ours.
 */

/** A rollout's size, and when it was last seen to differ from the size before it. */
export type RolloutProgress = { size: number; seenAtMs: number };

/**
 * Tracks progress by the rollout's size rather than its modification time.
 *
 * Windows does not push a file's last-write time to the directory entry while a
 * handle stays open for appending, and Codex holds the rollout open for the
 * life of the session. One measured here still reported 05:02 fifty minutes
 * after its last record was written at 05:51, which made every long-lived
 * conversation look stalled. `stat` reads the size from the file itself and it
 * was exact to the byte, so growth is the signal and the clock is ours.
 *
 * First sight is not evidence of anything: how long a rollout had been quiet
 * before this process started looking is not knowable, so the clock starts now
 * rather than claiming a stall that may never have happened.
 */
export function noteRolloutSize(previous: RolloutProgress | undefined, size: number, nowMs: number): RolloutProgress {
  if (previous && previous.size === size) return previous;
  return { size, seenAtMs: nowMs };
}

/** How long a working turn may record nothing before it is called out. */
export const TURN_STALL_MS = 5 * 60_000;

/** How often the sweep looks. One stat per conversation that is working. */
export const TURN_STALL_POLL_MS = 30_000;

export type StallDecision =
  /** Mark it, dated to the last progress there was rather than to now. */
  | { action: "mark"; since: string }
  | { action: "clear" }
  | { action: "none" };

export function decideStall(input: {
  /** Whether the runner is on a turn at all. */
  working: boolean;
  /** When the rollout was last written, or null when it cannot be read. */
  lastProgressAtMs: number | null;
  /** What is currently recorded on the runner. */
  stalledSince: string | null;
  nowMs: number;
  thresholdMs?: number;
}): StallDecision {
  const { working, lastProgressAtMs, stalledSince, nowMs } = input;
  const threshold = input.thresholdMs ?? TURN_STALL_MS;
  // A turn that ended is not stalled, whatever the rollout looks like.
  if (!working) return stalledSince ? { action: "clear" } : { action: "none" };
  // No readable rollout is not evidence of a stall; saying so would put a
  // warning on every conversation whose file has not been found yet.
  if (lastProgressAtMs === null) return stalledSince ? { action: "clear" } : { action: "none" };
  if (nowMs - lastProgressAtMs < threshold) return stalledSince ? { action: "clear" } : { action: "none" };
  if (stalledSince) return { action: "none" };
  return { action: "mark", since: new Date(lastProgressAtMs).toISOString() };
}

