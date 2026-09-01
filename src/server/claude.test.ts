import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClaudeCommand, buildClaudeHookSettings, ClaudeCodeManager } from "./claude.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Claude Code provider", () => {
  it("builds authenticated HTTP hook settings and a native resume command", () => {
    const settings = buildClaudeHookSettings("D:\\promptor dir\\scripts\\claude-hook.mjs", "C:\\Program Files\\nodejs\\node.exe") as any;
    expect(Object.keys(settings.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]);
    expect(settings.hooks.SessionStart[0].hooks[0]).toMatchObject({ type: "command", timeout: 10 });
    expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("claude-hook.mjs\" SessionStart");
    const command = buildClaudeCommand("D:\\work dir", "D:\\data dir\\settings.json", { mode: "resume", sessionId: "00000000-0000-4000-8000-000000000001" }, "light");
    expect(command).toContain("& claude --resume 00000000-0000-4000-8000-000000000001 --settings");
    expect(command).toContain('$env:CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1"');
    expect(command).toContain("__CLAUDE_PROMPTOR_EXIT__:");
    expect(command).toContain("Set-Location -LiteralPath 'D:\\work dir'");
  });

  it("normalizes prompt and Stop hooks into the queue turn protocol", async () => {
    const writes: string[] = [];
    const submitted: string[] = [];
    const fakePty = {
      submitPrompt: (_tabId: string, text: string) => { submitted.push(text); return true; },
      write: (_tabId: string, data: string) => { writes.push(data); },
    } as any;
    const manager = new ClaudeCodeManager("tab-1", fakePty);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-claude-"));
    temporaryDirectories.push(directory);
    await manager.beginLaunch({
      cwd: directory,
      launch: { mode: "new" },
      hookScriptPath: path.join(process.cwd(), "scripts", "claude-hook.mjs"),
      settingsPath: path.join(directory, "settings.json"),
      theme: "light",
      exitMarker: "__CLAUDE_PROMPTOR_EXIT__:test:",
    });
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-1", cwd: directory, transcript_path: path.join(directory, "session-1.jsonl") });
    expect((await manager.waitForSession()).sessionId).toBe("session-1");

    const starting = manager.rpc.startTurn("session-1", "queue prompt", "client-1", directory);
    await expect(manager.rpc.startTurn("session-1", "racing prompt", "client-race", directory)).rejects.toThrow("CLAUDE_PROMPT_SUBMISSION_IN_FLIGHT");
    await vi.waitFor(() => expect(submitted).toEqual(["queue prompt"]));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt_id: "prompt-1", prompt: "queue prompt" });
    const { turnId } = await starting;
    expect(turnId).toBe("prompt-1");
    expect(manager.rpc.activeTurnIds("session-1")).toEqual(["prompt-1"]);

    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt_id: "manual-steer", prompt: "manual follow-up" });
    expect(manager.rpc.activeTurnIds("session-1")).toEqual(["prompt-1"]);

    await manager.handleHook({ hook_event_name: "Stop", session_id: "session-1", prompt_id: "prompt-1", last_assistant_message: "final response" });
    const completed = await manager.rpc.waitForTurn("prompt-1");
    expect(completed.turn.status).toBe("completed");
    expect(completed.items.at(-1)).toMatchObject({ phase: "final_answer", text: "final response" });
    expect(manager.rpc.activeTurnIds("session-1")).toEqual([]);

    const second = manager.rpc.startTurn("session-1", "interrupt me", "client-2", directory);
    await vi.waitFor(() => expect(submitted).toContain("interrupt me"));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt_id: "prompt-2", prompt: "interrupt me" });
    await second;
    await manager.rpc.interruptTurn("session-1", "prompt-2");
    expect(writes).toContain("\x1b");
    expect((await manager.rpc.waitForTurn("prompt-2")).turn.status).toBe("interrupted");

    const exiting = manager.rpc.startTurn("session-1", "terminal exits", "client-3", directory);
    await vi.waitFor(() => expect(submitted).toContain("terminal exits"));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt_id: "prompt-3", prompt: "terminal exits" });
    await exiting;
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-2", cwd: directory, transcript_path: path.join(directory, "session-2.jsonl"), source: "resume" });
    expect(manager.session?.sessionId).toBe("session-2");
    expect((await manager.rpc.waitForTurn("prompt-3")).turn.status).toBe("interrupted");
    await expect(manager.rpc.startTurn("session-1", "old session", "client-old", directory)).rejects.toThrow("SESSION_NOT_READY");

    const afterSwitch = manager.rpc.startTurn("session-2", "new session prompt", "client-4", directory);
    await vi.waitFor(() => expect(submitted).toContain("new session prompt"));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-2", prompt_id: "prompt-4", prompt: "new session prompt" });
    await afterSwitch;
    manager.observeTerminalExit();
    expect((await manager.rpc.waitForTurn("prompt-4")).turn.status).toBe("interrupted");
    await expect(manager.rpc.startTurn("session-2", "too late", "client-5", directory)).rejects.toThrow("SESSION_NOT_READY");
  });

  it("returns a transcript-reconciled completion instead of losing the finished turn", async () => {
    const submitted: string[] = [];
    const fakePty = {
      submitPrompt: (_tabId: string, text: string) => { submitted.push(text); return true; },
      write: () => undefined,
    } as any;
    const manager = new ClaudeCodeManager("tab-reconcile", fakePty);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-claude-reconcile-"));
    temporaryDirectories.push(directory);
    const transcriptPath = path.join(directory, "session-reconcile.jsonl");
    await fs.writeFile(transcriptPath, "", "utf8");
    await manager.beginLaunch({
      cwd: directory,
      launch: { mode: "new" },
      hookScriptPath: path.join(process.cwd(), "scripts", "claude-hook.mjs"),
      settingsPath: path.join(directory, "settings.json"),
      theme: "light",
      exitMarker: "__CLAUDE_PROMPTOR_EXIT__:test:",
    });
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-reconcile", cwd: directory, transcript_path: transcriptPath });

    const starting = manager.rpc.startTurn("session-reconcile", "reconcile this", "client-reconcile", directory);
    await vi.waitFor(() => expect(submitted).toEqual(["reconcile this"]));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-reconcile", prompt_id: "prompt-reconcile", prompt: "reconcile this" });
    expect((await starting).turnId).toBe("prompt-reconcile");
    await fs.appendFile(transcriptPath, [
      JSON.stringify({ type: "user", uuid: "prompt-reconcile", timestamp: "2026-09-01T09:00:00.000Z", message: { role: "user", content: "reconcile this" } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-09-01T09:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "recovered answer" }], stop_reason: "end_turn" } }),
      "",
    ].join("\n"), "utf8");

    vi.useFakeTimers();
    try {
      const waiting = manager.rpc.waitForTurn("prompt-reconcile");
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(waiting).resolves.toMatchObject({
        turn: { id: "prompt-reconcile", status: "completed" },
        items: [{ type: "userMessage", text: "reconcile this" }, { type: "agentMessage", phase: "final_answer", text: "recovered answer" }],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
