import { describe, expect, it, vi } from "vitest";
import { buildCodexHookOverride, buildCodexTuiLaunch, codexHookStartupError, CodexTuiManager } from "./codex-tui.js";

describe("Codex native PTY/hooks provider", () => {
  it("builds per-run hooks and keeps every Codex argument in an argv slot", () => {
    const hookPath = "D:\\Promptor dir\\scripts\\codex-hook.mjs";
    const nodePath = "C:\\Program Files\\nodejs\\node.exe";
    const override = buildCodexHookOverride(hookPath, nodePath);
    expect(override).toContain("SessionStart=[{hooks=[{");
    expect(override).toContain("UserPromptSubmit=[{hooks=[{");
    expect(override).toContain("PostCompact=[{hooks=[{");
    expect(override).toContain("codex-hook.mjs");

    const launch = buildCodexTuiLaunch(
      "D:\\work dir",
      { mode: "resume", sessionId: "00000000-0000-4000-8000-000000000001" },
      hookPath,
      nodePath,
    );
    expect(launch.executable).toBe("codex");
    expect(launch.args.slice(0, 2)).toEqual(["resume", "00000000-0000-4000-8000-000000000001"]);
    expect(launch.args).toContain("D:\\work dir");
    expect(launch.args).not.toContain("--remote");
    expect(launch.args).not.toContain("--dangerously-bypass-hook-trust");
    expect(launch.args.at(-1)).toBe(override);
  });

  it("normalizes Codex hooks into the common queue turn protocol", async () => {
    const submitted: string[] = [];
    const writes: string[] = [];
    const manager = new CodexTuiManager("tab-codex", {
      submitPrompt: (_tabId: string, text: string) => { submitted.push(text); return true; },
      write: (_tabId: string, data: string) => { writes.push(data); },
    } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "new" }, hookScriptPath: "scripts/codex-hook.mjs" });
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-1", cwd: "D:\\work", transcript_path: "D:\\rollout.jsonl" });
    expect((await manager.waitForSession()).sessionId).toBe("session-1");

    const starting = manager.rpc.startTurn("session-1", "queue prompt", "client-1", "D:\\work");
    await expect(manager.rpc.startTurn("session-1", "racing prompt", "client-race", "D:\\work")).rejects.toThrow("CODEX_PROMPT_SUBMISSION_IN_FLIGHT");
    await vi.waitFor(() => expect(submitted).toEqual(["queue prompt"]));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", turn_id: "turn-1", prompt: "queue prompt" });
    expect((await starting).turnId).toBe("turn-1");
    expect(manager.rpc.activeTurnIds("session-1")).toEqual(["turn-1"]);

    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", turn_id: "turn-1", prompt: "manual follow-up" });
    expect(manager.rpc.activeTurnIds("session-1")).toEqual(["turn-1"]);
    await manager.handleHook({ hook_event_name: "Stop", session_id: "session-1", turn_id: "turn-1", last_assistant_message: "final response" });
    const completed = await manager.rpc.waitForTurn("turn-1");
    expect(completed.turn.status).toBe("completed");
    expect(completed.items.at(-1)).toMatchObject({ phase: "final_answer", text: "final response" });

    const interrupted = manager.rpc.startTurn("session-1", "interrupt me", "client-2", "D:\\work");
    await vi.waitFor(() => expect(submitted).toContain("interrupt me"));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", turn_id: "turn-2", prompt: "interrupt me" });
    await interrupted;
    await manager.rpc.interruptTurn("session-1", "turn-2");
    expect(writes).toContain("\x1b");
    expect((await manager.rpc.waitForTurn("turn-2")).turn.status).toBe("interrupted");
  });

  it("fails closed when Codex reports that hooks are untrusted", () => {
    expect(codexHookStartupError("Warning: hook configuration is not trusted")).toBe("CODEX_HOOK_TRUST_REQUIRED");
    expect(codexHookStartupError("Codex ready")).toBeNull();
  });
});
