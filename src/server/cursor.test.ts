import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCursorCommand, CursorCliManager, ensureCursorHookBridge } from "./cursor.js";

const temporaryDirectories: string[] = [];
const originalCursorConfigDir = process.env.CURSOR_CONFIG_DIR;

afterEach(async () => {
  if (originalCursorConfigDir === undefined) delete process.env.CURSOR_CONFIG_DIR;
  else process.env.CURSOR_CONFIG_DIR = originalCursorConfigDir;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("Cursor CLI provider", () => {
  it("uses the requested agent command and preserves existing user hooks", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-cursor-"));
    temporaryDirectories.push(directory);
    process.env.CURSOR_CONFIG_DIR = path.join(directory, "cursor-config");
    await fs.mkdir(process.env.CURSOR_CONFIG_DIR, { recursive: true });
    await fs.writeFile(path.join(process.env.CURSOR_CONFIG_DIR, "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "existing-hook" }] } }), "utf8");

    const result = await ensureCursorHookBridge(process.cwd(), path.join(directory, "backups"));
    const hooks = JSON.parse(await fs.readFile(result.hooksPath, "utf8"));
    expect(hooks.hooks.stop[0]).toEqual({ command: "existing-hook" });
    expect(hooks.hooks.stop.some((entry: any) => entry.command.includes("cursor-hook.mjs") && entry.command.endsWith(" stop"))).toBe(true);
    expect(hooks.hooks.beforeSubmitPrompt.some((entry: any) => entry.command.includes("cursor-hook.mjs"))).toBe(true);
    expect((await fs.readdir(path.join(directory, "backups"))).length).toBe(1);

    const command = buildCursorCommand("D:\\work dir", { mode: "resume", sessionId: "00000000-0000-4000-8000-000000000001" }, "light");
    expect(command).toContain("& agent --resume=00000000-0000-4000-8000-000000000001");
    expect(command).toContain("__CURSOR_PROMPTOR_EXIT__:");
  });

  it("refuses to overwrite a malformed existing hook structure", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-cursor-invalid-"));
    temporaryDirectories.push(directory);
    process.env.CURSOR_CONFIG_DIR = path.join(directory, "cursor-config");
    await fs.mkdir(process.env.CURSOR_CONFIG_DIR, { recursive: true });
    const hooksPath = path.join(process.env.CURSOR_CONFIG_DIR, "hooks.json");
    const original = JSON.stringify({ version: 1, hooks: { stop: { command: "user-hook" } } });
    await fs.writeFile(hooksPath, original, "utf8");

    await expect(ensureCursorHookBridge(process.cwd(), path.join(directory, "backups"))).rejects.toThrow("CURSOR_HOOKS_INVALID_JSON");
    expect(await fs.readFile(hooksPath, "utf8")).toBe(original);
  });

  it("normalizes Cursor lifecycle hooks into queue turns", async () => {
    const submitted: string[] = [];
    const writes: string[] = [];
    const manager = new CursorCliManager("tab", {
      submitPrompt: (_tabId: string, text: string) => { submitted.push(text); return true; },
      write: (_tabId: string, data: string) => { writes.push(data); },
    } as any);
    manager.beginLaunch("D:\\work");
    await manager.handleHook({ hook_event_name: "sessionStart", conversation_id: "session", session_id: "narrow-session", workspace_roots: ["D:\\work"], transcript_path: "D:\\cursor.jsonl" });
    expect((await manager.waitForSession()).sessionId).toBe("session");

    const starting = manager.rpc.startTurn("session", "cursor prompt", "client", "D:\\work");
    await expect(manager.rpc.startTurn("session", "racing prompt", "client-race", "D:\\work")).rejects.toThrow("CURSOR_PROMPT_SUBMISSION_IN_FLIGHT");
    await vi.waitFor(() => expect(submitted).toEqual(["cursor prompt"]));
    expect(await manager.handleHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "session", generation_id: "generation", prompt: "cursor prompt" })).toEqual({ continue: true });
    expect((await starting).turnId).toBe("generation");
    await manager.handleHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "session", generation_id: "manual-steer", prompt: "manual follow-up" });
    expect(manager.rpc.activeTurnIds("session")).toEqual(["generation"]);
    await manager.handleHook({ hook_event_name: "afterAgentResponse", conversation_id: "session", generation_id: "generation", text: "cursor answer" });
    await manager.handleHook({ hook_event_name: "stop", conversation_id: "session", generation_id: "generation", status: "completed" });
    const completed = await manager.rpc.waitForTurn("generation");
    expect(completed.items.at(-1)).toMatchObject({ phase: "final_answer", text: "cursor answer" });
    expect(manager.rpc.activeTurnIds("session")).toEqual([]);

    const interrupted = manager.rpc.startTurn("session", "stop", "client-2", "D:\\work");
    await vi.waitFor(() => expect(submitted).toContain("stop"));
    await manager.handleHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "session", generation_id: "generation-2", prompt: "stop" });
    await interrupted;
    await manager.rpc.interruptTurn("session", "generation-2");
    expect(writes).toContain("\x1b");
    expect((await manager.rpc.waitForTurn("generation-2")).turn.status).toBe("interrupted");

    const exiting = manager.rpc.startTurn("session", "terminal exits", "client-3", "D:\\work");
    await vi.waitFor(() => expect(submitted).toContain("terminal exits"));
    await manager.handleHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "session", generation_id: "generation-3", prompt: "terminal exits" });
    await exiting;
    await manager.handleHook({ hook_event_name: "sessionStart", conversation_id: "session-2", session_id: "narrow-2", workspace_roots: ["D:\\work"], transcript_path: "D:\\cursor-2.jsonl" });
    expect(manager.session?.sessionId).toBe("session-2");
    expect((await manager.rpc.waitForTurn("generation-3")).turn.status).toBe("interrupted");
    await expect(manager.rpc.startTurn("session", "old session", "client-old", "D:\\work")).rejects.toThrow("SESSION_NOT_READY");

    const afterSwitch = manager.rpc.startTurn("session-2", "new session prompt", "client-4", "D:\\work");
    await vi.waitFor(() => expect(submitted).toContain("new session prompt"));
    await manager.handleHook({ hook_event_name: "beforeSubmitPrompt", conversation_id: "session-2", generation_id: "generation-4", prompt: "new session prompt" });
    await afterSwitch;
    manager.observeTerminalExit();
    expect((await manager.rpc.waitForTurn("generation-4")).turn.status).toBe("interrupted");
    await expect(manager.rpc.startTurn("session-2", "too late", "client-5", "D:\\work")).rejects.toThrow("SESSION_NOT_READY");
  });
});
