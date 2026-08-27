import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";

describe("timer and common-prompt HTTP API", () => {
  let app: PromptorApp;
  let root: string;
  let tabId: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-timer-api-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();
    const tab = await app.promptor.storage.createTab("timer api");
    tabId = tab.id;
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: {
        ...current.session,
        provider: "codex",
        state: "ready",
        threadId: "api-thread",
        sessionId: "api-thread",
        workingDirectory: root,
        connectedAt: isoNow(),
      },
    }));
  });

  afterEach(async () => {
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("revalidates timer reads and protects every configuration write with If-Match", async () => {
    const empty = await request("GET", `/api/tabs/${tabId}/timers`);
    expect(empty.statusCode).toBe(200);
    expect(empty.json().data).toEqual({ schemaVersion: 1, updatedAt: null, timers: [] });
    const emptyTag = String(empty.headers.etag);

    const unchanged = await request("GET", `/api/tabs/${tabId}/timers`, undefined, { "if-none-match": emptyTag });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload).toHaveLength(0);

    const draft = timerDraft();
    expect((await request("POST", `/api/tabs/${tabId}/timers`, draft)).statusCode).toBe(428);
    expect((await request("POST", `/api/tabs/${tabId}/timers`, draft, { "if-match": '"stale"' })).statusCode).toBe(412);

    const created = await request("POST", `/api/tabs/${tabId}/timers`, draft, { "if-match": emptyTag });
    expect(created.statusCode).toBe(200);
    expect(created.headers["cache-control"]).toContain("no-store");
    const timer = created.json().data.timer;
    expect(timer).toMatchObject({ title: "Daily review", threadId: "api-thread", enabled: true });
    const createdTag = String(created.headers.etag);

    expect((await request("DELETE", `/api/tabs/${tabId}/timers/${timer.id}`, undefined, { "if-match": emptyTag })).statusCode).toBe(412);
    const removed = await request("DELETE", `/api/tabs/${tabId}/timers/${timer.id}`, undefined, { "if-match": createdTag });
    expect(removed.statusCode).toBe(204);
    expect(removed.headers.etag).toBeTruthy();
  });

  it("saves the ordered common list and returns an idempotent run-now batch immediately", async () => {
    const common = await request("GET", "/api/common-prompts");
    const commonTag = String(common.headers.etag);
    const saved = await request("PUT", "/api/common-prompts", {
      items: [
        { id: "two", title: "Second", text: "second body" },
        { id: "one", title: "First", text: "first body" },
      ],
    }, { "if-match": commonTag });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().data.items.map((item: { id: string }) => item.id)).toEqual(["two", "one"]);

    const emptyTimers = await request("GET", `/api/tabs/${tabId}/timers`);
    const created = await request("POST", `/api/tabs/${tabId}/timers`, { ...timerDraft(), enabled: false }, { "if-match": String(emptyTimers.headers.etag) });
    const timer = created.json().data.timer;
    const runOneShotBatch = vi.spyOn(app.promptor.runners.get(tabId), "runOneShotBatch").mockResolvedValue(undefined);
    const key = "2a1d6552-3ddb-4f6a-b3c5-f79f3fc1d760";
    const first = await request("POST", `/api/tabs/${tabId}/timers/${timer.id}/run-now`, {}, { "idempotency-key": key });
    const retry = await request("POST", `/api/tabs/${tabId}/timers/${timer.id}/run-now`, {}, { "idempotency-key": key });

    expect(first.statusCode).toBe(202);
    expect(first.headers["cache-control"]).toContain("no-store");
    expect(retry.json().data.promptIds).toEqual(first.json().data.promptIds);
    expect((await app.promptor.storage.readPromptsOnly(tabId)).prompts).toHaveLength(1);
    expect(runOneShotBatch).toHaveBeenCalledTimes(2);
  });

  function request(method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) {
    return app.inject({
      method: method as any,
      url,
      headers: { "x-codex-promptor-token": app.promptor.token, ...extraHeaders },
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
  }
});

function timerDraft() {
  const future = new Date(Date.now() + 60 * 60_000);
  const localDateTime = `${future.getFullYear()}-${two(future.getMonth() + 1)}-${two(future.getDate())}T${two(future.getHours())}:${two(future.getMinutes())}`;
  return {
    title: "Daily review",
    enabled: true,
    externalQueuePolicy: "after_running_queue",
    schedule: { kind: "once", localDateTime },
    prompts: [{ id: "template", text: "review" }],
  };
}

function two(value: number): string { return String(value).padStart(2, "0"); }
