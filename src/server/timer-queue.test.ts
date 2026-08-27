import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import { QueueRunner } from "./queue.js";
import { StorageService } from "./storage.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

describe("timer one-shot queue batches", () => {
  it("runs only registered timer prompts while a user queue is paused and preserves timer provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-timer-queue-"));
    roots.push(root);
    const storage = new StorageService(root);
    const tab = await storage.createTab("timer queue");
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: { ...current.session, state: "ready", threadId: "thread", sessionId: "thread", workingDirectory: root, connectedAt: isoNow() },
    }));
    const bundle = await storage.readTab(tab.id);
    bundle.runtime.runner.desiredState = "paused";
    await storage.writeRuntime(tab.id, bundle.runtime);
    const userPrompt = newPrompt("leave pending", "queue");
    const timerPrompt = newPrompt("run by timer", "timer");
    timerPrompt.threadId = "thread";
    timerPrompt.timerId = "timer";
    timerPrompt.timerOccurrenceId = "occurrence";
    timerPrompt.timerAutoRun = true;
    bundle.prompts.prompts.push(userPrompt, timerPrompt);
    await storage.writePrompts(tab.id, bundle.prompts);

    const calls: string[] = [];
    const runner = new QueueRunner(tab.id, storage, {
      rpc: {
        activeTurnIds: () => [],
        waitForThreadIdle: async () => undefined,
        startTurn: async (_threadId, text) => { calls.push(text); return { turnId: "timer-turn" }; },
        waitForTurn: async () => ({
          turn: { id: "timer-turn", status: "completed" },
          items: [
            { type: "userMessage", text: "run by timer" },
            { type: "agentMessage", phase: "final_answer", text: "timer complete" },
          ],
        }),
        steerTurn: async () => undefined,
        interruptTurn: async () => undefined,
      },
    });

    await runner.runOneShotBatch([timerPrompt.id]);
    await waitUntil(async () => (await storage.readRuntime(tab.id)).runner.state === "paused"
      && (await storage.readPromptsOnly(tab.id)).prompts.find((prompt) => prompt.id === timerPrompt.id)?.status === "completed");
    const result = await storage.readTab(tab.id);

    expect(calls).toEqual(["run by timer"]);
    expect(result.runtime.runner.desiredState).toBe("paused");
    expect(result.prompts.prompts.find((prompt) => prompt.id === userPrompt.id)?.status).toBe("pending");
    expect(result.prompts.prompts.find((prompt) => prompt.id === timerPrompt.id)).toMatchObject({ status: "completed", origin: "timer" });
    expect(result.prompts.prompts.find((prompt) => prompt.id === timerPrompt.id)?.timerAutoRun).toBeUndefined();
    expect(result.prompts.prompts.find((prompt) => prompt.id === timerPrompt.id)?.attempts[0]?.origin).toBe("timer");
    expect(result.answers.answers[0]).toMatchObject({ origin: "timer", finalAnswer: "timer complete" });
    await runner.stop();
  });
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for timer queue");
}
