import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  defaultAnswerFile,
  defaultPromptFile,
  isoNow,
  type AnswerRecord,
  type PromptRecord,
  type TabMeta,
} from "../shared/schemas.js";
import { EARLIER_ANSWER_PAGE, INITIAL_ANSWER_WINDOW } from "../shared/tab-window.js";
import { createApp, type PromptorApp } from "./app.js";

const THREAD = "thread-1";

function answerAt(index: number): AnswerRecord {
  const now = isoNow();
  return {
    id: `a${index}`,
    promptId: `p${index}`,
    threadId: THREAD,
    codexTurnId: `turn-${index}`,
    clientUserMessageId: null,
    prompt: `prompt ${index}`,
    finalAnswer: `answer ${index}`.repeat(200),
    status: "completed",
    origin: "queue",
    captureMode: "phase_final_answer",
    error: null,
    startedAt: now,
    completedAt: now,
    recordedAt: now,
    metadata: {},
  } as AnswerRecord;
}

function promptAt(index: number, status: PromptRecord["status"]): PromptRecord {
  const now = isoNow();
  return {
    id: `p${index}`,
    text: `prompt ${index}`,
    status,
    createdAt: now,
    updatedAt: now,
    origin: "queue",
    threadId: THREAD,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    codexTurnId: `turn-${index}`,
    clientUserMessageId: null,
    attempts: [],
    error: null,
  } as PromptRecord;
}

describe("bounded conversation reads", () => {
  let app: PromptorApp;
  let root = "";
  let tab: TabMeta;

  // 60 settled turns plus 40 still pending: enough history that a full read
  // would be the expensive thing this window exists to avoid.
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-window-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    tab = await app.promptor.storage.createTab("history");
    tab.session = { ...tab.session, provider: "codex", state: "ready", threadId: THREAD };
    await app.promptor.storage.writeTab(tab);
    await app.promptor.storage.writePrompts(tab.id, {
      ...defaultPromptFile(),
      prompts: [
        ...Array.from({ length: 60 }, (_unused, index) => promptAt(index, "completed")),
        ...Array.from({ length: 40 }, (_unused, index) => promptAt(60 + index, "pending")),
      ],
    });
    await app.promptor.storage.writeAnswers(tab.id, {
      ...defaultAnswerFile(),
      answers: Array.from({ length: 60 }, (_unused, index) => answerAt(index)),
    });
  });

  afterAll(async () => {
    await app.promptor.close();
    await app.close();
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const get = (url: string, headers: Record<string, string> = {}) => app.inject({
    method: "GET",
    url,
    headers: { "x-codex-promptor-token": app.promptor.token, ...headers },
  });

  it("opens a conversation on the last few answers and reports the rest as pageable", async () => {
    const response = await get(`/api/tabs/${tab.id}`);
    expect(response.statusCode).toBe(200);
    const bundle = response.json().data;
    expect(bundle.answers.answers).toHaveLength(INITIAL_ANSWER_WINDOW);
    expect(bundle.answers.answers.at(-1).id).toBe("a59");
    expect(bundle.window.answers).toEqual({ start: 60 - INITIAL_ANSWER_WINDOW, total: 60 });
  });

  it("ships every prompt still waiting to run, whatever the window asks for", async () => {
    const bundle = (await get(`/api/tabs/${tab.id}?promptLimit=1`)).json().data;
    const pending = bundle.prompts.prompts.filter((prompt: PromptRecord) => prompt.status === "pending");
    // Reordering posts the complete pending list back, so a clipped one would
    // make the server reject every drag.
    expect(pending).toHaveLength(40);
    expect(bundle.window.prompts.start).toBe(60);
    expect(bundle.window.prompts.completed).toBe(60);
  });

  it("leaves reconciliation provenance on disk instead of on the wire", async () => {
    const stored = await app.promptor.storage.readTab(tab.id);
    stored.prompts.prompts[60].inputSnapshot = [{ type: "text", text: "x".repeat(4_000) }];
    await app.promptor.storage.writePrompts(tab.id, stored.prompts);

    const bundle = (await get(`/api/tabs/${tab.id}`)).json().data;
    const sent = bundle.prompts.prompts.find((prompt: PromptRecord) => prompt.id === "p60");
    expect(sent).toBeDefined();
    expect(sent.inputSnapshot).toBeUndefined();
    // Still on disk: the read is what drops it, not the write.
    expect((await app.promptor.storage.readTab(tab.id)).prompts.prompts[60].inputSnapshot).toBeDefined();
  });

  it("pages backwards from the window start", async () => {
    const page = (await get(`/api/tabs/${tab.id}/answers/page?before=${60 - INITIAL_ANSWER_WINDOW}`)).json().data;
    expect(page.records).toHaveLength(EARLIER_ANSWER_PAGE);
    expect(page).toMatchObject({ start: 60 - INITIAL_ANSWER_WINDOW - EARLIER_ANSWER_PAGE, total: 60 });
    expect(page.records.at(-1).id).toBe(`a${60 - INITIAL_ANSWER_WINDOW - 1}`);
  });

  it("answers an unchanged re-read from the browser's own copy", async () => {
    const first = await get(`/api/tabs/${tab.id}`);
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();
    expect(first.headers["cache-control"]).toContain("no-cache");

    const revalidated = await get(`/api/tabs/${tab.id}`, { "if-none-match": etag });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.rawPayload.length).toBe(0);
  });

  it("sends the body again once the conversation has moved on", async () => {
    const etag = (await get(`/api/tabs/${tab.id}`)).headers.etag as string;
    const prompts = await app.promptor.storage.readTab(tab.id).then((bundle) => bundle.prompts);
    await app.promptor.storage.writePrompts(tab.id, { ...prompts, revision: prompts.revision + 1, updatedAt: isoNow() });

    const response = await get(`/api/tabs/${tab.id}`, { "if-none-match": etag });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.prompts.revision).toBe(prompts.revision + 1);
  });
});
