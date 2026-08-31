import { describe, expect, it, vi } from "vitest";
import { buildCodexHookOverride, buildCodexTuiLaunch, codexHookFailureText, codexHookStartupError, codexStartupQuestion, codexStartupQuestionFrom, CodexTuiManager, resolveHookCommandPaths, spaceFreePath } from "./codex-tui.js";

describe("Codex native PTY/hooks provider", () => {
  it("builds per-run hooks and keeps every Codex argument in an argv slot", () => {
    const hookPath = "D:\\promptor\\scripts\\codex-hook.mjs";
    const nodePath = "C:\\PROGRA~1\\nodejs\\node.exe";
    const override = buildCodexHookOverride(hookPath, nodePath);
    expect(override).toContain("SessionStart=[{hooks=[{");
    expect(override).toContain("UserPromptSubmit=[{hooks=[{");
    expect(override).toContain("PostCompact=[{hooks=[{");
    expect(override).toContain("codex-hook.mjs");
    // Codex splits a hook command on whitespace and does not honour quotes:
    // measured on 0.147.0, the same executable runs bare and reports
    // "SessionStart Failed" the moment it is wrapped in quotes.
    expect(override).not.toContain('\\"');

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

describe("hook commands Codex can actually run", () => {
  it("refuses a path with a space rather than emitting a command that cannot run", () => {
    // Quoting does not rescue it -- quotes become part of the program name --
    // so a spaced path has no representation here at all. Failing by name beats
    // a hook that is silently never invoked, whose only symptom is SessionStart
    // never arriving thirty seconds later.
    expect(() => buildCodexHookOverride("D:\\p\\hook.mjs", "C:\\Program Files\\nodejs\\node.exe"))
      .toThrow("CODEX_HOOK_PATH_HAS_SPACES:C:" + String.fromCharCode(92) + "Program Files" + String.fromCharCode(92) + "nodejs" + String.fromCharCode(92) + "node.exe");
    expect(() => buildCodexHookOverride("D:\\Promptor dir\\hook.mjs", "C:\\node.exe"))
      .toThrow("CODEX_HOOK_PATH_HAS_SPACES");
  });

  it("passes a path through untouched when it has no whitespace", async () => {
    await expect(spaceFreePath("C:\\PROGRA~1\\nodejs\\node.exe")).resolves.toBe("C:\\PROGRA~1\\nodejs\\node.exe");
  });

  it("resolves the real Node path into something runnable", async () => {
    // process.execPath is "C:\\Program Files\\nodejs\\node.exe" on this
    // machine, which is exactly the case that used to produce a dead hook.
    const resolved = await resolveHookCommandPaths(process.execPath, process.execPath).catch(() => null);
    if (!resolved) return; // 8.3 names can be disabled per volume; nothing to assert
    expect(resolved.node).not.toMatch(/\s/u);
    expect(resolved.script).not.toMatch(/\s/u);
  });
});

describe("the questions Codex asks before a session exists", () => {
  // Both captured from codex-cli 0.147.0 through the PTY this app launches.
  const hooksReview = [
    "  Hooks need review",
    "  6 hooks are new or changed.",
    "  Hooks can run outside the sandbox after you trust them.",
    "",
    "› 1. Review hooks",
    "  2. Trust all and continue",
    "  3. Continue without trusting (hooks won't run)",
    "",
    "  Press enter to confirm or esc to go back",
  ].join(String.fromCharCode(10));
  const directoryTrust = [
    "> You are in C:\\work\\project",
    "",
    "  Do you trust the contents of this directory? Working with untrusted contents",
    "  comes with higher risk of prompt injection. Trusting the directory allows",
    "  project-local config, hooks, and exec policies to load.",
    "",
    "› 1. Yes, continue",
    "  2. No, quit",
    "",
    "  Press enter to continue",
  ].join(String.fromCharCode(10));

  it("reads a question as a question, not as a startup failure", () => {
    // Treating one as an error tore the terminal down, taking away the prompt
    // the reader was supposed to answer.
    expect(codexStartupQuestion(hooksReview)).toBe("Hooks need review");
    expect(codexHookStartupError(hooksReview)).toBeNull();
  });

  it("recognises a question this code has never seen by its shape", () => {
    // The hooks review is not the only screen that can stop a launch, and the
    // trust prompt comes first: matching wordings would still time out here.
    expect(codexStartupQuestion(directoryTrust))
      .toBe("Do you trust the contents of this directory? Working with untrusted contents");
  });

  it("survives the control sequences a real terminal wraps it in", () => {
    const painted = "\u001b[2J\u001b[1;1H\u001b[33m" + hooksReview + "\u001b[0m";
    expect(codexStartupQuestion(painted)).toBe("Hooks need review");
  });

  it("is not seen in ordinary output", () => {
    expect(codexStartupQuestion("codex resuming thread 01a0...")).toBeNull();
    // A list with no one waiting on it is not a question.
    expect(codexStartupQuestion("› 1. Review hooks\n  2. Trust all and continue")).toBeNull();
  });

  it("stops the clock while a question is on screen, and names it when it is never answered", async () => {
    const manager = new CodexTuiManager("tab-question", { write: () => undefined } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "new" }, hookScriptPath: "scripts/codex-hook.mjs" });
    let onScreen = true;
    const started = Date.now();
    // A 20ms budget would have expired long before this resolves; the question
    // has to hold it open for the reader, then hand back what to answer.
    const waiting = manager.waitForSession(20, undefined, () => (onScreen ? codexStartupQuestion(hooksReview) : null), 400);
    setTimeout(() => { onScreen = false; }, 250);
    await expect(waiting).rejects.toThrow("CODEX_STARTUP_QUESTION_UNANSWERED:Hooks need review");
    expect(Date.now() - started).toBeGreaterThan(200);
  });

  it("tells the reader what to do about each hook failure", () => {
    const unanswered = codexHookFailureText("CODEX_STARTUP_QUESTION_UNANSWERED:Hooks need review");
    expect(unanswered).toContain("Hooks need review");
    expect(unanswered).toContain("Trust all and continue");
    expect(codexStartupQuestionFrom("CODEX_STARTUP_QUESTION_UNANSWERED:Hooks need review")).toBe("Hooks need review");
    expect(codexStartupQuestionFrom("CODEX_HOOK_TRUST_REQUIRED")).toBeNull();
    expect(codexHookFailureText("CODEX_HOOK_PATH_HAS_SPACES:C:/Program Files/node.exe")).toContain("空格");
    expect(codexHookFailureText("CODEX_TUI_LAUNCH_NOT_PREPARED")).toBeNull();
  });
});
