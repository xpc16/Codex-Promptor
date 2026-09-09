import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeManager } from "./claude.js";
import { CodexTuiManager } from "./codex-tui.js";
import { CursorCliManager } from "./cursor.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const providers = [
  { name: "Claude", Manager: ClaudeCodeManager, start: "SessionStart", prompt: "UserPromptSubmit", stop: "Stop",
    beginning: [{ type: "user", uuid: "turn", message: { role: "user", content: "manual prompt" } }],
    ending: [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "finished" }], stop_reason: "end_turn" } }],
  },
  { name: "Codex", Manager: CodexTuiManager, start: "SessionStart", prompt: "UserPromptSubmit", stop: "Stop",
    beginning: [
      { payload: { type: "task_started", turn_id: "turn" } },
      { payload: { type: "item_completed", turn_id: "turn", item: { type: "UserMessage", content: [{ type: "input_text", text: "manual prompt" }] } } },
    ],
    ending: [{ payload: { type: "task_complete", turn_id: "turn", last_agent_message: "finished" } }],
  },
  { name: "Cursor", Manager: CursorCliManager, start: "sessionStart", prompt: "beforeSubmitPrompt", stop: "stop",
    beginning: [{ hook_event_name: "beforeSubmitPrompt", generation_id: "turn", prompt: "manual prompt" }],
    ending: [
      { hook_event_name: "afterAgentResponse", generation_id: "turn", text: "finished" },
      { hook_event_name: "stop", generation_id: "turn", status: "completed" },
    ],
  },
];

describe.each(providers)("$name idle wait", ({ Manager, start, prompt, stop, beginning, ending }) => {
  async function setup() {
    const root = await mkdtemp(path.join(os.tmpdir(), "promptor-native-idle-"));
    temporaryDirectories.push(root);
    const file = path.join(root, "session.jsonl");
    await writeFile(file, "", "utf8");
    const pty = { write: vi.fn(), submitPrompt: vi.fn() };
    const manager = new Manager("tab", pty as any);
    await manager.handleHook({ hook_event_name: start, session_id: "session", cwd: root, transcript_path: file });
    await appendFile(file, jsonl(beginning), "utf8");
    await manager.handleHook({ hook_event_name: prompt, session_id: "session", turn_id: "turn", prompt_id: "turn", generation_id: "turn", prompt: "manual prompt" });
    return { manager, pty, file };
  }

  it("keeps a genuinely busy turn active, then recovers a missing completion hook from local records", async () => {
    const { manager, pty, file } = await setup();
    await expect(manager.rpc.waitForThreadIdle("session", 25)).rejects.toThrow("THREAD_IDLE_TIMEOUT");
    expect(manager.rpc.activeTurnIds("session")).toEqual(["turn"]);
    await appendFile(file, jsonl(ending), "utf8");
    // No waitForTurn subscriber or Stop hook: idle waiting must reconcile too.
    await expect(manager.rpc.waitForThreadIdle("session", 25)).resolves.toBeUndefined();
    expect(manager.rpc.activeTurnIds("session")).toEqual([]);
    expect((await manager.rpc.waitForTurn("turn")).turn.status).toBe("completed");
    expect(manager.listenerCount("turnCompleted")).toBe(0);
    expect(pty.write).not.toHaveBeenCalled();
    expect(pty.submitPrompt).not.toHaveBeenCalled();
  });

  it("accepts a Stop hook arriving exactly at the idle deadline", async () => {
    const { manager } = await setup();
    vi.useFakeTimers();
    setTimeout(() => { void manager.handleHook({ hook_event_name: stop, session_id: "session", turn_id: "turn", prompt_id: "turn", generation_id: "turn", last_assistant_message: "finished" }); }, 500);
    const waiting = manager.rpc.waitForThreadIdle("session", 500);
    const check = expect(waiting).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(500);
    await check;
    expect(manager.listenerCount("turnCompleted")).toBe(0);
  });
});

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify({ timestamp: "2026-09-01T00:00:00.000Z", ...record as object })).join("\n") + "\n";
}
