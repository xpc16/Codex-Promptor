import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectCodexSubmission, inspectCursorSubmission, reconcileCodexTurn, transcriptCursor } from "./transcript-reconciliation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("provider transcript reconciliation", () => {
  it("uses Codex rollout boundaries to confirm and settle a lost hook", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-rollout-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "rollout-session.jsonl");
    const records = [
      { timestamp: "2026-08-31T01:00:00.000Z", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: "2026-08-31T01:00:01.000Z", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "UserMessage", content: [{ type: "input_text", text: "hello\nworld" }] } } },
      { timestamp: "2026-08-31T01:00:02.000Z", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "AgentMessage", content: [{ type: "output_text", text: "answer" }] } } },
      { timestamp: "2026-08-31T01:00:03.000Z", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "answer" } },
    ];
    await fs.writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const evidence = await inspectCodexSubmission({ path: file, offset: 0 }, "hello\r\nworld", "session");
    expect(evidence).toMatchObject({ state: "accepted", turnId: "turn-1" });
    expect(await reconcileCodexTurn({ path: file, offset: 0 }, "session", "turn-1", "hello\nworld")).toMatchObject({
      status: "completed",
      answer: "answer",
      completedAt: "2026-08-31T01:00:03.000Z",
    });
  });

  it("retries Enter only when the recognized rollout has not grown", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-rollout-empty-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "rollout-session.jsonl");
    await fs.writeFile(file, "", "utf8");
    expect(await inspectCodexSubmission({ path: file, offset: 0 }, "hello", "session")).toEqual({ state: "not-submitted" });

    await fs.writeFile(file, `${JSON.stringify({ payload: { type: "future_shape", prompt: "hello" } })}\n`, "utf8");
    expect(await inspectCodexSubmission({ path: file, offset: 0 }, "hello", "session")).toEqual({
      state: "unknown",
      reason: "CODEX_ROLLOUT_SHAPE_UNKNOWN",
    });
  });

  it("reconciles a Cursor JSON document from its record count instead of its byte offset", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-cursor-document-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "chat.json");
    await fs.writeFile(file, JSON.stringify({ messages: [{ role: "user", content: "older" }] }), "utf8");
    const cursor = await transcriptCursor(file);
    expect(cursor).toMatchObject({ format: "json", recordCount: 1 });
    await fs.writeFile(file, JSON.stringify({ messages: [
      { role: "user", content: "older" },
      { role: "user", id: "new-generation", content: "new prompt" },
    ] }, null, 2), "utf8");
    expect(await inspectCursorSubmission(cursor, "new prompt")).toEqual({ state: "accepted", turnId: "new-generation" });
  });

  it("snapshots complete JSONL records but re-reads an unfinished final record", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-jsonl-cursor-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "transcript.jsonl");
    const first = `${JSON.stringify({ type: "user", message: { role: "user", content: "old" } })}\n`;
    const completeTail = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "done" } });
    await fs.writeFile(file, first + completeTail, "utf8");
    expect((await transcriptCursor(file)).offset).toBe(Buffer.byteLength(first + completeTail));

    const partial = '{"type":"user","message":{"role":"user","content":"new';
    await fs.writeFile(file, first + partial, "utf8");
    const cursor = await transcriptCursor(file);
    expect(cursor.offset).toBe(Buffer.byteLength(first));
    expect(await inspectCursorSubmission(cursor, "new prompt")).toMatchObject({ state: "unknown" });

    await fs.appendFile(file, ' prompt"}}\n', "utf8");
    expect(await inspectCursorSubmission(cursor, "new prompt")).toMatchObject({ state: "accepted" });
  });
});
