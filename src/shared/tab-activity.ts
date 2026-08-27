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
