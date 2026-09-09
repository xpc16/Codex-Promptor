import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import { QueueRunner, type QueueRpc } from "./queue.js";
import { StorageService } from "./storage.js";

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("queue waiting for a busy terminal", () => {
  let root: string;
  let storage: StorageService;
  let tabId: string;
  let runner: QueueRunner;
  let rpc: QueueRpc;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-queue-idle-"));
    storage = new StorageService(root);
    await storage.ensure();
    const tab = await storage.createTab("busy terminal");
    tabId = tab.id;
    await storage.updateTab(tabId, (current) => ({
      ...current,
      session: { ...current.session, provider: "claude", state: "ready", threadId: "thread", sessionId: "thread", workingDirectory: root },
    }));
    const prompts = await storage.readPromptsOnly(tabId);
    prompts.prompts.push(newPrompt("next prompt", "queue"));
    await storage.writePrompts(tabId, prompts);
    rpc = {
      activeTurnIds: vi.fn(() => []),
      waitForThreadIdle: vi.fn(async () => undefined),
      startTurn: vi.fn(async () => ({ turnId: "queued-turn" })),
      waitForTurn: vi.fn(async () => ({
        turn: { id: "queued-turn", status: "completed", completedAt: isoNow() },
        items: [{ type: "agentMessage", phase: "final_answer", text: "done" }],
      })),
      steerTurn: vi.fn(),
      interruptTurn: vi.fn(),
    };
    runner = new QueueRunner(tabId, storage, { rpc }, 50, 0);
  });

  afterEach(async () => {
    await runner?.stop();
    await rm(root, { recursive: true, force: true });
  });

  it("keeps waiting across repeated idle timeouts and submits exactly once when the terminal finishes", async () => {
    const waits = [gate(), gate(), gate()];
    vi.mocked(rpc.waitForThreadIdle)
      .mockImplementationOnce(() => waits[0].promise)
      .mockImplementationOnce(() => waits[1].promise)
      .mockImplementationOnce(() => waits[2].promise);
    const errors = vi.fn();
    runner.on("error", errors);
    await runner.start();
    await vi.waitFor(() => expect(rpc.waitForThreadIdle).toHaveBeenCalledTimes(1));
    const revision = (await storage.readRuntime(tabId)).revision;
    for (let index = 0; index < 2; index += 1) {
      waits[index].reject(new Error("THREAD_IDLE_TIMEOUT"));
      await vi.waitFor(() => expect(rpc.waitForThreadIdle).toHaveBeenCalledTimes(index + 2));
      const runtime = await storage.readRuntime(tabId);
      expect(runtime.runner).toMatchObject({ state: "waiting_for_thread", desiredState: "running", lastError: null, activePromptId: null });
      expect(runtime.revision).toBe(revision);
      expect((await storage.readPromptsOnly(tabId)).prompts[0]).toMatchObject({ status: "pending", attempts: [] });
      expect(rpc.startTurn).not.toHaveBeenCalled();
    }
    waits[2].resolve();
    await vi.waitFor(async () => expect((await storage.readRuntime(tabId)).runner.desiredState).toBe("armed"));
    expect(rpc.startTurn).toHaveBeenCalledExactlyOnceWith("thread", "next prompt", expect.any(String), root);
    expect((await storage.readPromptsOnly(tabId)).prompts[0].status).toBe("completed");
    expect(errors).not.toHaveBeenCalled();
  });

  it("does not turn an explicit pause into an error when the old wait times out", async () => {
    const wait = gate();
    vi.mocked(rpc.waitForThreadIdle).mockImplementationOnce(() => wait.promise);
    await runner.start();
    await vi.waitFor(() => expect(rpc.waitForThreadIdle).toHaveBeenCalledOnce());
    await runner.pause();
    wait.reject(new Error("THREAD_IDLE_TIMEOUT"));
    await vi.waitFor(async () => expect((await storage.readRuntime(tabId)).runner).toMatchObject({ state: "paused", desiredState: "paused", lastError: null }));
    expect(rpc.startTurn).not.toHaveBeenCalled();
  });

  it("preserves paused timer one-shot intent across a busy wait", async () => {
    const wait = gate();
    vi.mocked(rpc.waitForThreadIdle).mockRejectedValueOnce(new Error("THREAD_IDLE_TIMEOUT")).mockImplementationOnce(() => wait.promise);
    const promptId = (await storage.readPromptsOnly(tabId)).prompts[0].id;
    await runner.pause();
    await runner.runOneShotBatch([promptId]);
    await vi.waitFor(() => expect(rpc.waitForThreadIdle).toHaveBeenCalledTimes(2));
    expect((await storage.readRuntime(tabId)).runner).toMatchObject({ desiredState: "paused", state: "waiting_for_thread", lastError: null });
    wait.resolve();
    await vi.waitFor(async () => expect((await storage.readRuntime(tabId)).runner.state).toBe("paused"));
    expect((await storage.readPromptsOnly(tabId)).prompts[0].status).toBe("completed");
    expect(rpc.startTurn).toHaveBeenCalledOnce();
  });

  it("does not send to the old session when a session switch releases the wait", async () => {
    const wait = gate();
    vi.mocked(rpc.waitForThreadIdle).mockImplementationOnce(() => wait.promise);
    await runner.start();
    await vi.waitFor(() => expect(rpc.waitForThreadIdle).toHaveBeenCalledOnce());
    await storage.updateTab(tabId, (current) => ({ ...current, session: { ...current.session, threadId: "new-thread", sessionId: "new-thread" } }));
    wait.resolve();
    await vi.waitFor(async () => expect((await storage.readRuntime(tabId)).runner.desiredState).toBe("armed"));
    expect(rpc.startTurn).toHaveBeenCalledExactlyOnceWith("new-thread", "next prompt", expect.any(String), root);
  });

  it("still reports actual provider failures", async () => {
    vi.mocked(rpc.waitForThreadIdle).mockRejectedValueOnce(new Error("CONNECTION_CLOSED"));
    await runner.start();
    await vi.waitFor(async () => expect((await storage.readRuntime(tabId)).runner).toMatchObject({
      desiredState: "paused", state: "error", lastError: { code: "THREAD_NOT_IDLE", message: "CONNECTION_CLOSED" },
    }));
    expect(rpc.startTurn).not.toHaveBeenCalled();
  });
});
