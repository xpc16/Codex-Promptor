import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import { StorageService, writeFileAtomicWithRetry } from "./storage.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("atomic JSON writes", () => {
  it("retries transient Windows rename failures", async () => {
    const writer = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
      .mockResolvedValue(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(writeFileAtomicWithRetry("runtime.json", "{}\n", writer, delay)).resolves.toBeUndefined();

    expect(writer).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenNthCalledWith(1, 40);
    expect(delay).toHaveBeenNthCalledWith(2, 80);
  });

  it("does not retry unrelated filesystem failures", async () => {
    const failure = Object.assign(new Error("disk error"), { code: "EIO" });
    const writer = vi.fn().mockRejectedValue(failure);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(writeFileAtomicWithRetry("runtime.json", "{}\n", writer, delay)).rejects.toBe(failure);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});

describe("bounded tab history", () => {
  it("pages and emits totals for only the current thread", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-storage-"));
    temporaryRoots.push(root);
    const storage = new StorageService(root);
    const tab = await storage.createTab("history");
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, provider: "codex", state: "ready", threadId: "thread-current", sessionId: "thread-current" },
      updatedAt: isoNow(),
    }));
    const bundle = await storage.readTab(tab.id);
    const old = { ...newPrompt("old"), threadId: "thread-old", status: "completed" as const, completedAt: isoNow() };
    const current = { ...newPrompt("current"), threadId: "thread-current", status: "completed" as const, completedAt: isoNow() };
    const pending = newPrompt("pending");
    const deltas: any[] = [];
    storage.onPromptsChanged((_tabId, delta) => deltas.push(delta));

    bundle.prompts.prompts = [old, current, pending];
    bundle.prompts.revision += 1;
    bundle.prompts.updatedAt = isoNow();
    await storage.writePrompts(tab.id, bundle.prompts);

    expect(deltas.at(-1)).toMatchObject({ total: 2, completed: 1 });
    expect(deltas.at(-1).upserts.map((prompt: { text: string }) => prompt.text)).toEqual(["current", "pending"]);
    const window = await storage.readTabWindow(tab.id, 1, 1);
    expect(window.window?.prompts).toEqual({ start: 1, total: 2, completed: 1 });
    expect(window.prompts.prompts.map((prompt) => prompt.text)).toEqual(["pending"]);
    const page = await storage.readPromptPage(tab.id, 1, 1);
    expect(page).toMatchObject({ start: 0, total: 2 });
    expect(page.records.map((prompt) => prompt.text)).toEqual(["current"]);
  });

  it("reads finished prompts in the order they finished, not the order they were queued", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-storage-"));
    temporaryRoots.push(root);
    const storage = new StorageService(root);
    const tab = await storage.createTab("order");
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      session: { ...current.session, provider: "codex", state: "ready", threadId: "thread", sessionId: "thread" },
      updatedAt: isoNow(),
    }));
    const bundle = await storage.readTab(tab.id);
    // Queued first but retried, so it finished last -- the case that made the
    // stored order the wrong thing to read the history in.
    const settled = (text: string, completedAt: string) => ({ ...newPrompt(text), threadId: "thread", status: "completed" as const, completedAt });
    const queued = { ...newPrompt("still queued"), threadId: "thread" };

    bundle.prompts.prompts = [
      settled("retried", "2026-08-27T12:05:00.000Z"),
      settled("second", "2026-08-27T12:01:00.000Z"),
      settled("third", "2026-08-27T12:02:00.000Z"),
      queued,
    ];
    bundle.prompts.revision += 1;
    bundle.prompts.updatedAt = isoNow();
    await storage.writePrompts(tab.id, bundle.prompts);

    const window = await storage.readTabWindow(tab.id, 10, 10);
    expect(window.prompts.prompts.map((prompt) => prompt.text))
      .toEqual(["second", "third", "retried", "still queued"]);
    // The stored file is untouched: this is a reading order, not a rewrite.
    expect((await storage.readTab(tab.id)).prompts.prompts.map((prompt) => prompt.text))
      .toEqual(["retried", "second", "third", "still queued"]);
  });
});

describe("new conversation placement", () => {
  it("inherits the anchor group and is inserted immediately below it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-storage-placement-"));
    temporaryRoots.push(root);
    const storage = new StorageService(root);
    const anchor = await storage.createTab("anchor");
    await storage.updateIndex((index) => ({
      ...index,
      groups: [{ id: "group", name: "Group", order: 0, collapsed: false }],
    }));
    await storage.updateTab(anchor.id, (tab) => ({ ...tab, groupId: "group", order: 0 }));
    const formerSecond = await storage.createTab("former second", { afterTabId: anchor.id });

    const inserted = await storage.createTab("inserted", { afterTabId: anchor.id });
    const ordered = (await storage.readIndex()).tabs
      .filter((tab) => tab.groupId === "group")
      .sort((a, b) => a.order - b.order);

    expect(inserted).toMatchObject({ groupId: "group", order: 1 });
    expect(ordered.map((tab) => tab.id)).toEqual([anchor.id, inserted.id, formerSecond.id]);
    expect((await storage.readTab(formerSecond.id)).tab.order).toBe(2);
  });
});
