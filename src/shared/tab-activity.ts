import type { PromptRecord, RuntimeFile, Session } from "./schemas.js";

export const PROMPT_COMPLETION_NOTICE_MS = 30_000;

export type TabActivitySummary = {
  runnerState: RuntimeFile["runner"]["state"];
  desiredState: RuntimeFile["runner"]["desiredState"];
  activePromptId: string | null;
  lastQueueCompletedAt: string | null;
};

export type TabVisualState = "closed" | "idle" | "running" | "error" | "neutral";

/**
 * States in which the agent is on a turn right now.
 *
 * "pausing" belongs here: it means the queue will stop *after* the current
 * turn, so the agent is still working and the indicator must still read as
 * working. What the pause changed is whether the queue keeps rolling, and
 * that is a separate indicator.
 */
const WORKING_RUNNER_STATES: ReadonlySet<RuntimeFile["runner"]["state"]> = new Set(["dispatching", "running", "pausing"]);

export function runnerIsWorking(state: RuntimeFile["runner"]["state"]): boolean {
  return WORKING_RUNNER_STATES.has(state);
}

/**
 * Where a runner's intent lands when the loop it belonged to no longer exists
 * -- across a service restart, or after a session was torn down and reopened.
 *
 * "paused" and "armed" are both idle. Nothing is in flight in either, and the
 * only difference between them is whether adding a prompt starts the queue, so
 * neither is unsafe to carry across and collapsing them threw away a choice
 * the user had made. "running" cannot survive: the loop, the turn and the
 * terminal behind it are all gone. It settles where a run that finishes on its
 * own settles -- armed, ready for the next prompt but not resuming by itself.
 */
export function settledDesiredState(desired: RuntimeFile["runner"]["desiredState"]): "paused" | "armed" {
  return desired === "paused" ? "paused" : "armed";
}

export function promptIsExecuting(activity: TabActivitySummary | undefined): boolean {
  if (!activity?.activePromptId) return false;
  return runnerIsWorking(activity.runnerState);
}

export function tabVisualState(sessionState: Session["state"], activity: TabActivitySummary | undefined): TabVisualState {
  if (sessionState === "closed") return "closed";
  if (sessionState === "error") return "error";
  if (sessionState !== "ready") return "neutral";
  return promptIsExecuting(activity) ? "running" : "idle";
}

export function latestQueueCompletion(prompts: PromptRecord[]): string | null {
  let latest: { value: string; epoch: number } | null = null;
  for (const prompt of prompts) {
    if (prompt.origin !== "queue" || prompt.status !== "completed" || !prompt.completedAt) continue;
    const epoch = Date.parse(prompt.completedAt);
    if (!Number.isFinite(epoch) || (latest && epoch <= latest.epoch)) continue;
    latest = { value: prompt.completedAt, epoch };
  }
  return latest?.value ?? null;
}

export function completionNoticeExpiresAt(completedAt: string | null): number | null {
  if (!completedAt) return null;
  const epoch = Date.parse(completedAt);
  return Number.isFinite(epoch) ? epoch + PROMPT_COMPLETION_NOTICE_MS : null;
}
