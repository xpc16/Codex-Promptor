import { describe, expect, it } from "vitest";
import { mergeRolloutTurns, parseCodexRollout } from "./codex-history.js";

const line = (value: unknown) => JSON.stringify(value);
const event = (type: string, turnId: string, extra: Record<string, unknown> = {}, timestamp = "2026-08-25T14:22:20.489Z") =>
  line({ timestamp, type: "event_msg", payload: { type, turn_id: turnId, ...extra } });
const userItem = (turnId: string, text: string, clientId?: string) =>
  event("item_completed", turnId, { item: { type: "UserMessage", id: `${turnId}-u`, content: [{ type: "text", text }], ...(clientId ? { client_id: clientId } : {}) } });
const agentItem = (turnId: string, text: string) =>
  event("item_completed", turnId, { item: { type: "AgentMessage", id: `${turnId}-a`, content: [{ type: "Text", text }], phase: "commentary" } });

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
