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

