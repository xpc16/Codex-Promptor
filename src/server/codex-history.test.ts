import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergeRolloutTurns, parseCodexRollout, readCodexRollout, readCodexThreadForHistory, continuesThread } from "./codex-history.js";

const line = (value: unknown) => JSON.stringify(value);
const event = (type: string, turnId: string, extra: Record<string, unknown> = {}, timestamp = "2026-08-25T14:22:20.489Z") =>
  line({ timestamp, type: "event_msg", payload: { type, turn_id: turnId, ...extra } });
const userItem = (turnId: string, text: string, clientId?: string) =>
  event("item_completed", turnId, { item: { type: "UserMessage", id: `${turnId}-u`, content: [{ type: "text", text }], ...(clientId ? { client_id: clientId } : {}) } });
const agentItem = (turnId: string, text: string) =>
  event("item_completed", turnId, { item: { type: "AgentMessage", id: `${turnId}-a`, content: [{ type: "Text", text }], phase: "commentary" } });
const legacyMessage = (turnId: string, role: "user" | "assistant", text: string, phase?: string) => line({
  timestamp: "2026-08-25T14:22:21.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    ...(phase ? { phase } : {}),
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  },
});

describe("Codex rollout history", () => {
  it("recovers a completed turn the App Server projection never reached", () => {
    const rollout = [
      event("task_started", "t1", { started_at: 1787667740 }),
      userItem("t1", "run it externally"),
      agentItem("t1", "thinking out loud"),
      event("task_complete", "t1", { last_agent_message: "done and committed" }, "2026-08-25T14:48:20.004Z"),
    ].join("\n");

    const thread = parseCodexRollout(rollout, "thread-1");
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].status).toBe("completed");
    expect(thread.turns[0].startedAt).toBe("2026-08-25T14:22:20.000Z");
    expect(thread.turns[0].completedAt).toBe("2026-08-25T14:48:20.004Z");
    expect(thread.turns[0].items).toEqual([
      { type: "userMessage", text: "run it externally" },
      // task_complete carries the closing answer verbatim, so mid-turn
      // commentary never gets mistaken for it.
      { type: "agentMessage", phase: "final_answer", text: "done and committed" },
    ]);
  });

  it("keeps an aborted turn's last commentary as a partial answer", () => {
    const rollout = [
      event("task_started", "t2", { started_at: 1787667740 }),
      userItem("t2", "stop halfway"),
      agentItem("t2", "got as far as this"),
      event("turn_aborted", "t2", {}, "2026-08-25T14:30:00.000Z"),
    ].join("\n");

    const turn = parseCodexRollout(rollout, "thread-1").turns[0];
    expect(turn.status).toBe("interrupted");
    expect(turn.items[1]).toEqual({ type: "agentMessage", phase: "partial_answer", text: "got as far as this" });
  });

  it("reports a turn with no terminal event as running, never as a finished answer", () => {
    const rollout = [event("task_started", "t3", { started_at: 1787667740 }), userItem("t3", "still going")].join("\n");
    const turn = parseCodexRollout(rollout, "thread-1").turns[0];
    expect(turn.status).toBe("running");
    expect(turn.items).toHaveLength(1);
  });

  it("carries the client id so a queued prompt still links to its own turn", () => {
    const rollout = [
      event("task_started", "t4", { started_at: 1787667740 }),
      userItem("t4", "queued", "codex-promptor-abc"),
      event("task_complete", "t4", { last_agent_message: "ok" }),
    ].join("\n");
    expect(parseCodexRollout(rollout, "thread-1").turns[0].items[0]).toMatchObject({ clientId: "codex-promptor-abc" });
  });

  it("ignores bookkeeping records and turns that never carried a prompt", () => {
    const rollout = [
      line({ type: "session_meta", payload: { id: "thread-1" } }),
      "not json at all",
      event("token_count", "t5", { total: 12 }),
      event("task_started", "t5", { started_at: 1787667740 }),
      event("task_complete", "t5", { last_agent_message: "orphan" }),
    ].join("\n");
    expect(parseCodexRollout(rollout, "thread-1").turns).toHaveLength(0);
  });

  it("imports legacy response_item turns without mistaking transport envelopes for prompts", () => {
    const rollout = [
      event("task_started", "legacy-turn", { started_at: 1787667740 }),
      legacyMessage("legacy-turn", "user", "<recommended_plugins>internal catalog</recommended_plugins>"),
      legacyMessage("legacy-turn", "user", "<environment_context><cwd>D:\\work</cwd></environment_context>"),
      legacyMessage("legacy-turn", "user", "the actual legacy prompt"),
      legacyMessage("legacy-turn", "assistant", "legacy final", "final_answer"),
      event("task_complete", "legacy-turn", {}),
    ].join("\n");

    expect(parseCodexRollout(rollout, "thread-legacy").turns).toEqual([expect.objectContaining({
      id: "legacy-turn",
      status: "completed",
      items: [
        { type: "userMessage", text: "the actual legacy prompt" },
        { type: "agentMessage", phase: "final_answer", text: "legacy final" },
      ],
    })]);
  });

  it("uses the active task as a fallback for old messages without passthrough metadata", () => {
    const message = (role: string, text: string, phase?: string) => line({
      timestamp: "2026-08-25T14:22:21.000Z",
      type: "response_item",
      payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }], ...(phase ? { phase } : {}) },
    });
    const turn = parseCodexRollout([
      event("task_started", "old-turn"),
      message("user", "old prompt"),
      message("assistant", "old answer", "final_answer"),
      event("task_complete", "old-turn"),
    ].join("\n"), "thread-old").turns[0];
    expect(turn.items.map((item) => item.text)).toEqual(["old prompt", "old answer"]);
  });

  it("only adds turns the App Server did not already return", () => {
    const apiThread = { turns: [{ id: "t1", status: "completed", items: [{ type: "userMessage", text: "richer api copy" }] }] };
    const rolloutTurns = parseCodexRollout([
      event("task_started", "t1", { started_at: 1787667740 }),
      userItem("t1", "rollout copy"),
      event("task_complete", "t1", { last_agent_message: "a" }),
      event("task_started", "t2", { started_at: 1787667800 }),
      userItem("t2", "only in the rollout"),
      event("task_complete", "t2", { last_agent_message: "b" }),
    ].join("\n"), "thread-1").turns;

    const merged = mergeRolloutTurns(apiThread, rolloutTurns);
    expect(merged.turns).toHaveLength(2);
    expect(merged.turns[0].items[0].text).toBe("richer api copy");
    expect(merged.turns[1].id).toBe("t2");
    expect(mergeRolloutTurns(apiThread, []).turns).toHaveLength(1);
  });
});

describe("reading a rollout from disk", () => {
  it("streams the file instead of holding it whole", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-rollout-"));
    try {
      const file = path.join(root, "thread-1.jsonl");
      // Padded well past what a single frame would carry, to exercise the path
      // that made a 200MB rollout unreadable rather than merely expensive.
      const padding = "x".repeat(200_000);
      await writeFile(file, [
        event("task_started", "t1", { started_at: 1787667740 }),
        event("item_completed", "t1", { item: { type: "ExecCommandOutput", id: "t1-noise", content: [{ type: "text", text: padding }] } }),
        userItem("t1", "从磁盘读出来的提示"),
        event("task_complete", "t1", { last_agent_message: "从磁盘读出来的回答" }),
        "",
      ].join("\n"), "utf8");

      const thread = await readCodexRollout(file, "thread-1");
      expect(thread.turns).toHaveLength(1);
      expect(thread.turns[0].items[0]).toMatchObject({ type: "userMessage", text: "从磁盘读出来的提示" });
      expect(thread.turns[0].items[1]).toMatchObject({ phase: "final_answer", text: "从磁盘读出来的回答" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("choosing a history source", () => {
  const summaryOnly = { thread: { id: "thread-1", status: { type: "idle" } } };

  it("does not ask for the full conversation when the rollout can supply it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codex-history-source-"));
    try {
      const file = path.join(root, "thread-1.jsonl");
      await writeFile(file, [
        event("task_started", "t1", { started_at: 1787667740 }),
        userItem("t1", "来自 rollout"),
        event("task_complete", "t1", { last_agent_message: "回答" }),
      ].join("\n"), "utf8");
      // `path` on the summary is the hint that avoids scanning the sessions tree.
      const rpc = {
        readThreadSummary: vi.fn().mockResolvedValue({ thread: { ...summaryOnly.thread, path: file } }),
        readThread: vi.fn(),
      };

      const thread = await readCodexThreadForHistory(rpc, "thread-1");

      expect(thread.turns).toHaveLength(1);
      expect(thread.turns[0].items[0].text).toBe("来自 rollout");
      // The whole point: the transfer stays flat no matter how long the thread got.
      expect(rpc.readThread).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to the App Server for a thread with no rollout written yet", async () => {
    const rpc = {
      readThreadSummary: vi.fn().mockResolvedValue(summaryOnly),
      readThread: vi.fn().mockResolvedValue({
        thread: { id: "thread-unwritten", turns: [{ id: "t1", status: "completed", items: [{ type: "userMessage", text: "只有投影里有" }] }] },
      }),
    };

    const thread = await readCodexThreadForHistory(rpc, "thread-unwritten");

    expect(thread.turns).toHaveLength(1);
    expect(rpc.readThread).toHaveBeenCalledWith("thread-unwritten");
  });
});

describe("a thread Codex rolled over by itself", () => {
  it("is recognised as carrying on from the thread it left", () => {
    // Codex forks a long conversation into a fresh thread, keeping the old
    // rollout as the new one's history base. Reported as a conversation switch
    // it read as though the reader had changed something; they had only typed
    // a prompt.
    expect(continuesThread({ threadId: "old", endByteOffset: 62119053 }, "old")).toBe(true);
  });

  it("is not claimed for a thread that came from somewhere else", () => {
    expect(continuesThread({ threadId: "other", endByteOffset: 10 }, "old")).toBe(false);
    expect(continuesThread(null, "old")).toBe(false);
    expect(continuesThread({ threadId: "old", endByteOffset: 10 }, null)).toBe(false);
  });
});
