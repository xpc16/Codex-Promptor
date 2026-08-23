import { describe, expect, it } from "vitest";
import { newPrompt } from "./schemas.js";
import {
  completionNoticeExpiresAt,
  latestQueueCompletion,
  promptIsExecuting,
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
