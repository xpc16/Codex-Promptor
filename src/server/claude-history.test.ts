import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "./claude-history.js";

const line = (value: unknown) => JSON.stringify(value);

describe("Claude Code transcript parsing", () => {
  it("imports distinct typed prompts and their end_turn answers", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", promptSource: "typed", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: "first prompt" } }),
      // Claude may persist an internal copy with the same prompt id. The human
      // record must remain authoritative.
      line({ type: "user", uuid: "u1-copy", parentUuid: "u1", promptId: "p1", timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: "internal wrapper" } }),
      line({ type: "assistant", uuid: "a1-text", parentUuid: "u1-copy", timestamp: "2026-08-25T01:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "answer one" }], stop_reason: null } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "a1-text", timestamp: "2026-08-25T01:00:02Z", message: { id: "m1", role: "assistant", content: [], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "tool", parentUuid: "a1", timestamp: "2026-08-25T01:00:03Z", message: { role: "user", content: [{ type: "tool_result", content: "not a prompt" }] } }),
      line({ type: "user", uuid: "u2", parentUuid: "tool", promptId: "p2", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:04Z", message: { role: "user", content: "second prompt" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-08-25T01:00:05Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "answer two" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-1");
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
    expect(thread.turns[0].items).toEqual([
      { type: "userMessage", text: "first prompt" },
      { type: "agentMessage", phase: "final_answer", text: "answer one" },
    ]);
    expect(thread.turns[1].items[1].text).toBe("answer two");
  });

  it("uses the active leaf lineage after a conversation rewind", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "root" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "root answer" }], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "abandoned-u", parentUuid: "a1", promptId: "old", origin: { kind: "human" }, message: { role: "user", content: "abandoned" } }),
      line({ type: "assistant", uuid: "abandoned-a", parentUuid: "abandoned-u", message: { id: "old-a", role: "assistant", content: [{ type: "text", text: "old answer" }], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", promptId: "p2", origin: { kind: "human" }, message: { role: "user", content: "replacement" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "new answer" }], stop_reason: "end_turn" } }),
      line({ type: "last-prompt", sessionId: "session-2", leafUuid: "a2", lastPrompt: "replacement" }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-2");
    expect(thread.turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
    expect(JSON.stringify(thread.turns)).not.toContain("abandoned");
  });

  it("follows the logical parent across compaction without importing compact control records", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: "before compact" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-25T01:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "before compact answer" }], stop_reason: "end_turn" } }),
      line({ type: "system", subtype: "turn_duration", uuid: "duration-1", parentUuid: "a1" }),
      line({ type: "user", uuid: "abandoned-u", parentUuid: "duration-1", promptId: "abandoned", origin: { kind: "human" }, message: { role: "user", content: "abandoned sibling" } }),
      line({ type: "assistant", uuid: "abandoned-a", parentUuid: "abandoned-u", message: { id: "abandoned-m", role: "assistant", content: [{ type: "text", text: "abandoned answer" }], stop_reason: "end_turn" } }),
      line({ type: "system", subtype: "compact_boundary", uuid: "compact-boundary", parentUuid: null, logicalParentUuid: "duration-1", content: "Conversation compacted" }),
      line({ type: "user", uuid: "compact-summary", parentUuid: "compact-boundary", promptId: "compact-control", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: internal summary" } }),
      line({ type: "user", uuid: "compact-command", parentUuid: "compact-summary", promptId: "compact-control", message: { role: "user", content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>next request</command-args>" } }),
      line({ type: "user", uuid: "compact-stdout", parentUuid: "compact-command", promptId: "compact-control", message: { role: "user", content: "<local-command-stdout>Compacted</local-command-stdout>" } }),
      line({ type: "user", uuid: "u2", parentUuid: "compact-stdout", promptId: "p2", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:02Z", message: { role: "user", content: "after compact" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-08-25T01:00:03Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "after compact answer" }], stop_reason: "end_turn" } }),
      line({ type: "last-prompt", sessionId: "session-compact", leafUuid: "a2", lastPrompt: "after compact" }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-compact");
    expect(thread.turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
    expect(thread.turns.map((turn) => turn.items[0].text)).toEqual(["before compact", "after compact"]);
    expect(thread.turns.map((turn) => turn.items[1].text)).toEqual(["before compact answer", "after compact answer"]);
    expect(JSON.stringify(thread.turns)).not.toContain("abandoned");
    expect(JSON.stringify(thread.turns)).not.toContain("compact-control");
    expect(JSON.stringify(thread.turns)).not.toContain("internal summary");
  });

  it("unwraps slash commands and ignores background task notifications", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: "<command-name>/plan</command-name>\n<command-message>plan</command-message>\n<command-args>inspect the index</command-args>" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-25T01:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "initial answer" }], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "notice", parentUuid: "a1", promptId: "system-1", promptSource: "system", origin: { kind: "task-notification" }, timestamp: "2026-08-25T01:00:02Z", message: { role: "user", content: "<task-notification><status>completed</status></task-notification>" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "notice", timestamp: "2026-08-25T01:00:03Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "final background result" }], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "u2", parentUuid: "a2", promptId: "p2", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:04Z", message: { role: "user", content: "next prompt" } }),
      line({ type: "assistant", uuid: "a3", parentUuid: "u2", timestamp: "2026-08-25T01:00:05Z", message: { id: "m3", role: "assistant", content: [{ type: "text", text: "next answer" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-3");
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0].items[0].text).toBe("/plan inspect the index");
    expect(thread.turns[0].items[1].text).toBe("initial answer\n\n---\n\nfinal background result");
    expect(JSON.stringify(thread.turns)).not.toContain("task-notification");
  });

  it("keeps a turn that never reached end_turn, tagging the last partial text instead of dropping it", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", promptSource: "typed", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:00Z", message: { role: "user", content: "start a long task" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-08-25T01:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Let me look into this" }], stop_reason: null } }),
      line({ type: "assistant", uuid: "a1-tool", parentUuid: "a1", timestamp: "2026-08-25T01:00:02Z", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", name: "Read" }], stop_reason: "tool_use" } }),
      // Transcript ends here: no assistant message ever reaches end_turn for p1.
      line({ type: "user", uuid: "u2", parentUuid: "a1-tool", promptId: "p2", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:03Z", message: { role: "user", content: "next prompt" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-08-25T01:00:04Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "answer two" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-4");
    expect(thread.turns).toHaveLength(2);
    expect(thread.turns[0]).toMatchObject({ id: "p1", status: "completed" });
    expect(thread.turns[0].items).toEqual([
      { type: "userMessage", text: "start a long task" },
      { type: "agentMessage", phase: "partial_answer", text: "Let me look into this" },
    ]);
    expect(thread.turns[1].items[1]).toMatchObject({ phase: "final_answer", text: "answer two" });
  });

  it("drops a prompt that never produced any assistant text at all", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>" } }),
      line({ type: "user", uuid: "u2", parentUuid: "u1", promptId: "p2", origin: { kind: "human" }, timestamp: "2026-08-25T01:00:01Z", message: { role: "user", content: "next prompt" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-08-25T01:00:02Z", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "answer two" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-5");
    expect(thread.turns.map((turn) => turn.id)).toEqual(["p2"]);
  });
});

describe("Claude turn completion detection", () => {
  it("treats stop_sequence as a finished turn, not a truncated one", () => {
    // A slash command whose turn ends on a stop sequence still ended cleanly;
    // reporting it as partial permanently mislabels a completed answer.
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "/update-config" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "No response requested." }], stop_reason: "stop_sequence" } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", promptId: "p2", origin: { kind: "human" }, message: { role: "user", content: "next" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-stop-sequence");
    expect(thread.turns[0].status).toBe("completed");
    expect(thread.turns[0].items[1]).toEqual({ type: "agentMessage", phase: "final_answer", text: "No response requested." });
  });

  it("reports the trailing turn as running while the agent is still working", () => {
    // Syncing mid-turn used to import the preamble as a finished-but-partial
    // answer, so a healthy turn displayed as "did not finish".
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "why does submit time out" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Now the retry ladder:" }], stop_reason: "tool_use" } }),
      line({ type: "user", uuid: "tr1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "tr1", message: { id: "m2", role: "assistant", content: [], stop_reason: "tool_use" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-inflight");
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].status).toBe("running");
  });

  it("still keeps a genuinely unfinished earlier turn as a partial answer", () => {
    // Once a later prompt closes the window, the missing stop reason is real.
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "first" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "half an answer" }], stop_reason: "tool_use" } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", promptId: "p2", origin: { kind: "human" }, message: { role: "user", content: "second" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "full answer" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-interrupted");
    expect(thread.turns[0].status).toBe("completed");
    expect(thread.turns[0].items[1]).toEqual({ type: "agentMessage", phase: "partial_answer", text: "half an answer" });
    expect(thread.turns[1].items[1].phase).toBe("final_answer");
  });

  it("keeps a max_tokens cutoff partial, since that answer really was truncated", () => {
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "write forever" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "cut off here" }], stop_reason: "max_tokens" } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", promptId: "p2", origin: { kind: "human" }, message: { role: "user", content: "next" } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-truncated");
    expect(thread.turns[0].items[1].phase).toBe("partial_answer");
  });
});

describe("Claude active lineage tip", () => {
  it("keeps the answer written after the recorded leaf, so a just-finished turn is not partial", () => {
    // "last-prompt" pins the leaf as of prompt submission. Everything the agent
    // appends while answering is a descendant of it, so an upward-only walk
    // dropped the end_turn and reported the finished turn as unfinished until
    // the next prompt happened to move the leaf forward.
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "ask" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "preamble before tools:" }], stop_reason: "tool_use" } }),
      line({ type: "last-prompt", sessionId: "session-tip", leafUuid: "a1", lastPrompt: "ask" }),
      line({ type: "user", uuid: "tr1", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
      line({ type: "assistant", uuid: "a2", parentUuid: "tr1", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "the real final answer" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-tip");
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0].status).toBe("completed");
    expect(thread.turns[0].items[1]).toEqual({ type: "agentMessage", phase: "final_answer", text: "the real final answer" });
  });

  it("still drops a branch abandoned before the current leaf", () => {
    // The forward walk only follows records appended after the leaf, so a
    // rewound sibling written earlier must stay out of the imported history.
    const transcript = [
      line({ type: "user", uuid: "u1", parentUuid: null, promptId: "p1", origin: { kind: "human" }, message: { role: "user", content: "root" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "root answer" }], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "abandoned-u", parentUuid: "a1", promptId: "old", origin: { kind: "human" }, message: { role: "user", content: "abandoned" } }),
      line({ type: "assistant", uuid: "abandoned-a", parentUuid: "abandoned-u", message: { id: "old-a", role: "assistant", content: [{ type: "text", text: "old answer" }], stop_reason: "end_turn" } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", promptId: "p2", origin: { kind: "human" }, message: { role: "user", content: "replacement" } }),
      line({ type: "last-prompt", sessionId: "session-rewound", leafUuid: "u2", lastPrompt: "replacement" }),
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "new answer" }], stop_reason: "end_turn" } }),
    ].join("\n");

    const thread = parseClaudeTranscript(transcript, "session-rewound");
    expect(thread.turns.map((turn) => turn.id)).toEqual(["p1", "p2"]);
    expect(JSON.stringify(thread.turns)).not.toContain("abandoned");
    expect(thread.turns[1].items[1].text).toBe("new answer");
  });
});
