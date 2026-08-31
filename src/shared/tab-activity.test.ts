import { describe, expect, it } from "vitest";
import { newPrompt } from "./schemas.js";
import {
  completionNoticeExpiresAt,
  latestQueueCompletion,
  promptIsExecuting,
  runnerIsWorking,
  settledDesiredState,
  tabVisualState,
  type TabActivitySummary,
} from "./tab-activity.js";

const activity = (patch: Partial<TabActivitySummary> = {}): TabActivitySummary => ({
  runnerState: "paused",
  desiredState: "paused",
  activePromptId: null,
  lastQueueCompletedAt: null,
  ...patch,
});

describe("tab activity", () => {
  it("distinguishes closed, idle, and actively running prompt states", () => {
    expect(tabVisualState("closed", activity())).toBe("closed");
    expect(tabVisualState("ready", activity())).toBe("idle");
    expect(tabVisualState("ready", activity({ runnerState: "running", desiredState: "running", activePromptId: "prompt-1" }))).toBe("running");
    expect(tabVisualState("ready", activity({ runnerState: "waiting_for_thread", desiredState: "running" }))).toBe("idle");
    expect(promptIsExecuting(activity({ runnerState: "dispatching", activePromptId: "prompt-1" }))).toBe(true);
  });

  it("finds the latest successful queue completion only", () => {
    const older = newPrompt("older", "queue");
    older.status = "completed";
    older.completedAt = "2026-08-22T01:00:00.000Z";
    const manual = newPrompt("manual", "manual");
    manual.status = "completed";
    manual.completedAt = "2026-08-22T03:00:00.000Z";
    const newer = newPrompt("newer", "queue");
    newer.status = "completed";
    newer.completedAt = "2026-08-22T02:00:00.000Z";

    expect(latestQueueCompletion([older, manual, newer])).toBe(newer.completedAt);
    expect(completionNoticeExpiresAt(newer.completedAt)).toBe(Date.parse(newer.completedAt) + 30_000);
  });
});

describe("what counts as the agent working", () => {
  it("keeps reading as working while the queue is set to stop after this turn", () => {
    // "pausing" is a decision about the *next* prompt; the current one is
    // still running, so the indicator must not go dark yet.
    expect(runnerIsWorking("pausing")).toBe(true);
    expect(runnerIsWorking("dispatching")).toBe(true);
    expect(runnerIsWorking("reconciling")).toBe(true);
    expect(runnerIsWorking("running")).toBe(true);
  });

  it("does not count idle or failed states as working", () => {
    expect(runnerIsWorking("paused")).toBe(false);
    expect(runnerIsWorking("waiting_for_prompt")).toBe(false);
    expect(runnerIsWorking("waiting_for_thread")).toBe(false);
    expect(runnerIsWorking("starting")).toBe(false);
    expect(runnerIsWorking("error")).toBe(false);
  });
});

describe("queue intent across a restart", () => {
  it("keeps both idle intents, because neither has anything in flight", () => {
    expect(settledDesiredState("paused")).toBe("paused");
    expect(settledDesiredState("armed")).toBe("armed");
  });

  it("settles a rolling queue where a finished run settles, rather than resuming it", () => {
    expect(settledDesiredState("running")).toBe("armed");
  });
});
