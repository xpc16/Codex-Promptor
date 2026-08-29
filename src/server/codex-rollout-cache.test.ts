import { mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readCodexRollout, readCodexRolloutSlice } from "./codex-history.js";
import { mergeCachedTurns, readCodexRolloutCached, ROLLOUT_PARSE_VERSION, type RolloutCache } from "./codex-rollout-cache.js";

const THREAD = "01a0240c-5f7f-7b22-a1e0-246baf68d2d8";

/** The lines a completed turn writes, in the order the rollout writes them. */
function turnLines(turnId: string, prompt: string, answer: string): string[] {
  return [
    JSON.stringify({ timestamp: "2026-08-28T00:00:00.000Z", payload: { type: "task_started", turn_id: turnId, started_at: "2026-08-28T00:00:00.000Z" } }),
    JSON.stringify({ timestamp: "2026-08-28T00:00:01.000Z", payload: { type: "item_completed", turn_id: turnId, item: { type: "userMessage", content: prompt, client_id: `client-${turnId}` } } }),
    JSON.stringify({ timestamp: "2026-08-28T00:00:02.000Z", payload: { type: "task_complete", turn_id: turnId, last_agent_message: answer } }),
  ];
}

/** A turn that has started but not finished, as an in-flight turn appears on disk. */
function runningTurnLines(turnId: string, prompt: string): string[] {
  return [
    JSON.stringify({ timestamp: "2026-08-28T00:01:00.000Z", payload: { type: "task_started", turn_id: turnId, started_at: "2026-08-28T00:01:00.000Z" } }),
    JSON.stringify({ timestamp: "2026-08-28T00:01:01.000Z", payload: { type: "item_completed", turn_id: turnId, item: { type: "userMessage", content: prompt } } }),
  ];
}

describe("incremental rollout reads", () => {
  let root: string;
  let file: string;
  let cache: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-rollout-cache-"));
    file = path.join(root, `rollout-${THREAD}.jsonl`);
    cache = path.join(root, "rollout-cache.json");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const write = (lines: string[]) => writeFile(file, `${lines.join("\n")}\n`, "utf8");
  const append = (lines: string[]) => appendFile(file, `${lines.join("\n")}\n`, "utf8");
  const readCache = async (): Promise<RolloutCache> => JSON.parse(await readFile(cache, "utf8"));

  it("returns the whole conversation while reading only what was appended", async () => {
    await write([...turnLines("t1", "一", "答一"), ...turnLines("t2", "二", "答二")]);
    const first = await readCodexRolloutCached(file, THREAD, cache);
    expect(first.turns.map((turn) => turn.id)).toEqual(["t1", "t2"]);
    const afterFirst = await readCache();
    expect(afterFirst.offset).toBeGreaterThan(0);

    await append(turnLines("t3", "三", "答三"));
    const second = await readCodexRolloutCached(file, THREAD, cache);

    // The point of the exercise: the earlier turns are still there, and they
    // came out of the cache rather than off the disk.
    expect(second.turns.map((turn) => turn.id)).toEqual(["t1", "t2", "t3"]);
    const slice = await readCodexRolloutSlice(file, THREAD, afterFirst.offset);
    expect(slice.turns.map((turn) => turn.id)).toEqual(["t3"]);
  });

  it("matches a full read exactly, however many appends it took to get there", async () => {
    // This is the property that matters: syncHistory deletes records for turns
    // missing from the list it is given, so an incremental read that differs
    // from the full one by a single turn would erase history.
    await write(turnLines("t1", "一", "答一"));
    await readCodexRolloutCached(file, THREAD, cache);
    await append(turnLines("t2", "二", "答二"));
    await readCodexRolloutCached(file, THREAD, cache);
    await append([...turnLines("t3", "三", "答三"), ...turnLines("t4", "四", "答四")]);

    const incremental = await readCodexRolloutCached(file, THREAD, cache);
    const full = await readCodexRollout(file, THREAD);
    expect(incremental).toEqual(full);
  });

  it("re-reads a turn that was still running when the cache was written", async () => {
    await write([...turnLines("t1", "一", "答一"), ...runningTurnLines("t2", "二")]);
    const first = await readCodexRolloutCached(file, THREAD, cache);
    expect(first.turns.find((turn) => turn.id === "t2")!.status).toBe("running");

    // The resume point sits at the start of the unfinished turn, not at the end
    // of the file, or its completion line would arrive with nothing to attach to.
    const cached = await readCache();
    const running = await readCodexRolloutSlice(file, THREAD, cached.offset);
    expect(running.turns.map((turn) => turn.id)).toEqual(["t2"]);

    await append([JSON.stringify({ timestamp: "2026-08-28T00:01:09.000Z", payload: { type: "task_complete", turn_id: "t2", last_agent_message: "答二" } })]);
    const second = await readCodexRolloutCached(file, THREAD, cache);
    const settled = second.turns.find((turn) => turn.id === "t2")!;
    expect(settled.status).toBe("completed");
    expect(settled.items.at(-1)).toMatchObject({ phase: "final_answer", text: "答二" });
    expect(second).toEqual(await readCodexRollout(file, THREAD));
  });

  it("does not let an abandoned turn pin the resume point forever", async () => {
    // A thread runs one turn at a time, so a turn still marked running with
    // finished turns after it never got its terminal event and never will.
    // One real conversation here re-read 61MB on every launch because of a turn
    // stranded 23 turns from the end.
    await write([
      ...turnLines("t1", "一", "答一"),
      ...runningTurnLines("stuck", "无终点"),
      ...turnLines("t3", "三", "答三"),
    ]);
    const thread = await readCodexRolloutCached(file, THREAD, cache);
    expect(thread.turns.find((turn) => turn.id === "stuck")!.status).toBe("running");

    // The stranded turn stays in the cache exactly as it is -- nothing is lost,
    // and syncHistory does not import a running turn anyway -- but the next
    // read starts past it rather than replaying everything after it.
    const cached = await readCache();
    expect(cached.offset).toBe((await readFile(file)).length);
    expect(await readCodexRolloutCached(file, THREAD, cache)).toEqual(await readCodexRollout(file, THREAD));
  });

  it("does not fold a half-written trailing line into the cache", async () => {
    await write(turnLines("t1", "一", "答一"));
    await appendFile(file, '{"timestamp":"2026-08-28T00:02:00.000Z","payl', "utf8");

    const thread = await readCodexRolloutCached(file, THREAD, cache);
    expect(thread.turns.map((turn) => turn.id)).toEqual(["t1"]);
    // It is parsed -- a last record with no newline yet is still real data, and
    // it is the one that settles a queue prompt -- but the cache stops before
    // it, so the next read sees it again once it has been terminated.
    const cached = await readCache();
    expect(cached.offset).toBeLessThan((await readFile(file)).length);
  });

  it("starts over when the rollout was rewritten, not replayed at a stale offset", async () => {
    await write([...turnLines("t1", "一", "答一"), ...turnLines("t2", "二", "答二")]);
    await readCodexRolloutCached(file, THREAD, cache);

    // Same path, same length band, different content: only the opening bytes
    // can tell the two apart, and an offset carried across would be nonsense.
    await write([...turnLines("r1", "重一", "答重一"), ...turnLines("r2", "重二", "答重二")]);
    const rebuilt = await readCodexRolloutCached(file, THREAD, cache);
    expect(rebuilt.turns.map((turn) => turn.id)).toEqual(["r1", "r2"]);
    expect(rebuilt).toEqual(await readCodexRollout(file, THREAD));
  });

  it("starts over for another thread, another parser, or a corrupt cache", async () => {
    await write(turnLines("t1", "一", "答一"));
    await readCodexRolloutCached(file, THREAD, cache);
    const good = await readCache();

    for (const broken of [
      { ...good, threadId: "someone-else" },
      { ...good, version: ROLLOUT_PARSE_VERSION + 1 },
      { ...good, file: path.join(root, "elsewhere.jsonl") },
      { ...good, turns: [], offset: 10 ** 9 },
    ]) {
      await writeFile(cache, JSON.stringify(broken), "utf8");
      expect(await readCodexRolloutCached(file, THREAD, cache)).toEqual(await readCodexRollout(file, THREAD));
    }

    await writeFile(cache, "not json at all", "utf8");
    expect(await readCodexRolloutCached(file, THREAD, cache)).toEqual(await readCodexRollout(file, THREAD));
  });
});

describe("mergeCachedTurns", () => {
  const turn = (id: string, status: "completed" | "running") => ({ id, status, startedAt: null, completedAt: null, items: [] });

  it("keeps the order turns were first seen in and updates the ones re-read", () => {
    const merged = mergeCachedTurns(
      [turn("t1", "completed"), turn("t2", "running")],
      [turn("t2", "completed"), turn("t3", "completed")],
    );
    expect(merged.map((item) => `${item.id}:${item.status}`)).toEqual(["t1:completed", "t2:completed", "t3:completed"]);
  });
});
