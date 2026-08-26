import { describe, expect, it } from "vitest";
import { parseCursorTranscript } from "./cursor-history.js";

describe("Cursor transcript parsing", () => {
  it("imports hook-style JSONL without treating tool results as prompts", () => {
    const transcript = [
      { hook_event_name: "beforeSubmitPrompt", conversation_id: "session", generation_id: "g1", prompt: "first", timestamp: "2026-08-25T01:00:00Z" },
      { type: "user", generation_id: "tool", message: { role: "user", content: [{ type: "tool_result", text: "ignored" }] } },
      { hook_event_name: "afterAgentResponse", conversation_id: "session", generation_id: "g1", text: "answer one", timestamp: "2026-08-25T01:00:01Z" },
      { hook_event_name: "beforeSubmitPrompt", conversation_id: "session", generation_id: "g2", prompt: "second", timestamp: "2026-08-25T01:00:02Z" },
      { type: "assistant", generation_id: "g2", message: { role: "assistant", content: [{ type: "text", text: "answer two" }] }, timestamp: "2026-08-25T01:00:03Z" },
    ].map((record) => JSON.stringify(record)).join("\n");
    const thread = parseCursorTranscript(transcript, "session");
    expect(thread.turns.map((turn) => turn.id)).toEqual(["g1", "g2"]);
    expect(thread.turns.map((turn) => turn.items.at(-1).text)).toEqual(["answer one", "answer two"]);
  });
});
