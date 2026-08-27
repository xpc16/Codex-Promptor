import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import { StorageService } from "./storage.js";
import { TimerService, timerFileEtag, timerOccurrenceId, timerPromptId } from "./timer-service.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("timer storage and mutations", () => {
  it("serves a stable virtual empty file without creating it", async () => {
    const { storage, tabId } = await fixture();
    const service = new TimerService(storage, () => ({ runOneShotBatch: async () => undefined }), () => undefined);

    const first = await service.getTimers(tabId);
    const second = await service.getTimers(tabId);

    expect(first.file).toEqual({ schemaVersion: 1, updatedAt: null, timers: [] });
    expect(second.etag).toBe(first.etag);
    await expect(fs.access(storage.timerPath(tabId))).rejects.toMatchObject({ code: "ENOENT" });
    await service.stop();
  });

  it("requires a current ETag before creating a timer", async () => {
    const { storage, tabId } = await fixture();
    const service = new TimerService(storage, () => ({ runOneShotBatch: async () => undefined }), () => undefined);
    const empty = await service.getTimers(tabId);
    const draft = timerDraft(localMinute(60_000));

    await expect(service.createTimer(tabId, draft, undefined)).rejects.toMatchObject({ statusCode: 428, code: "PRECONDITION_REQUIRED" });
    await expect(service.createTimer(tabId, draft, '"stale"')).rejects.toMatchObject({ statusCode: 412, code: "PRECONDITION_FAILED" });
    const created = await service.createTimer(tabId, draft, empty.etag);

    expect(created.file.timers).toHaveLength(1);
    expect(created.timer.threadId).toBe("thread-1");
    expect(created.etag).toBe(timerFileEtag(created.file));
    expect(await storage.hasTimerFile(tabId)).toBe(true);
    await service.stop();
  });

  it("materializes an idempotent manual batch and registers it without rolling the whole queue", async () => {
    const { storage, tabId } = await fixture();
    const batches: string[][] = [];
    const service = new TimerService(storage, () => ({ runOneShotBatch: async (ids) => { batches.push([...ids]); } }), () => undefined);
    const empty = await service.getTimers(tabId);
    const created = await service.createTimer(tabId, {
      ...timerDraft(localMinute(60_000)),
      enabled: false,
      prompts: [{ id: "template-a", text: "first" }, { id: "template-b", text: "second" }],
    }, empty.etag);
    const key = "d9428888-122b-4f6f-b0d4-2db3e28b9656";

    const first = await service.runNow(tabId, created.timer.id, key);
    const retry = await service.runNow(tabId, created.timer.id, key);
    const prompts = (await storage.readPromptsOnly(tabId)).prompts;
    const occurrence = timerOccurrenceId(created.timer.id, `manual:${key}`);

    expect(first.promptIds).toEqual([
      timerPromptId(occurrence, "template-a"),
      timerPromptId(occurrence, "template-b"),
    ]);
    expect(retry.promptIds).toEqual(first.promptIds);
    expect(prompts).toHaveLength(2);
    expect(prompts.map((prompt) => prompt.text)).toEqual(["first", "second"]);
    expect(prompts.every((prompt) => prompt.origin === "timer" && prompt.timerAutoRun === true && prompt.threadId === "thread-1")).toBe(true);
    expect(batches).toEqual([first.promptIds, first.promptIds]);
    await service.stop();
  });

  it("places priority timer prompts before existing pending work", async () => {
    const { storage, tabId } = await fixture();
    const bundle = await storage.readTab(tabId);
    bundle.prompts.prompts.push(newPrompt("existing"));
    await storage.writePrompts(tabId, bundle.prompts);
    const service = new TimerService(storage, () => ({ runOneShotBatch: async () => undefined }), () => undefined);
    const empty = await service.getTimers(tabId);
    const created = await service.createTimer(tabId, {
      ...timerDraft(localMinute(60_000)),
      enabled: false,
      externalQueuePolicy: "priority",
      prompts: [{ id: "priority", text: "timer first" }],
    }, empty.etag);

    await service.runNow(tabId, created.timer.id, "3944c71f-c1f0-4e69-9e0f-4206ce207543");
    expect((await storage.readPromptsOnly(tabId)).prompts.map((prompt) => prompt.text)).toEqual(["timer first", "existing"]);
    await service.stop();
  });
});

describe("timer scheduler", () => {
  it("coalesces an overdue one-time occurrence into one batch and disables the timer", async () => {
    const { storage, tabId } = await fixture();
    let now = new Date();
    const batches: string[][] = [];
    const holds: boolean[] = [];
    const service = new TimerService(
      storage,
      () => ({ runOneShotBatch: async (ids) => { batches.push([...ids]); } }),
      (_key, active) => { holds.push(active); },
      () => new Date(now),
    );
    const empty = await service.getTimers(tabId);
    const scheduled = localMinute(60_000, now);
    const created = await service.createTimer(tabId, timerDraft(scheduled), empty.etag);
    await service.start();

    now = new Date(now.getTime() + 2 * 60_000);
    await (service as unknown as { checkDueTimers(): Promise<void> }).checkDueTimers();

    const file = await storage.readTimers(tabId);
    expect(file.timers[0]).toMatchObject({ id: created.timer.id, enabled: false, nextRunAt: null });
    expect(file.timers[0].lastTrigger).toMatchObject({ source: "scheduled", status: "queued" });
    expect((await storage.readPromptsOnly(tabId)).prompts).toHaveLength(1);
    expect(holds).toContain(true);
    await service.stop();
  });
});

async function fixture(): Promise<{ storage: StorageService; tabId: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-timer-"));
  roots.push(root);
  const storage = new StorageService(root);
  const tab = await storage.createTab("timers");
  await storage.updateTab(tab.id, (current) => ({
    ...current,
    updatedAt: isoNow(),
    session: {
      ...current.session,
      provider: "codex",
      state: "ready",
      threadId: "thread-1",
      sessionId: "thread-1",
      workingDirectory: root,
      connectedAt: isoNow(),
    },
  }));
  return { storage, tabId: tab.id };
}

function timerDraft(localDateTime: string) {
  return {
    title: "Timer",
    enabled: true,
    externalQueuePolicy: "after_running_queue" as const,
    schedule: { kind: "once" as const, localDateTime },
    prompts: [{ id: "template-1", text: "scheduled prompt" }],
  };
}

function localMinute(offset: number, base = new Date()): string {
  const value = new Date(base.getTime() + offset);
  return `${value.getFullYear()}-${two(value.getMonth() + 1)}-${two(value.getDate())}T${two(value.getHours())}:${two(value.getMinutes())}`;
}

function two(value: number): string { return String(value).padStart(2, "0"); }
