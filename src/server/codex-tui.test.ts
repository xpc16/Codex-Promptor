import { describe, expect, it, vi } from "vitest";
import { buildCodexHookOverride, buildCodexTuiLaunch, codexHookFailureText, codexHookStartupError, codexStartupQuestion, codexStartupQuestionFrom, codexTuiReady, CodexTuiManager, resolveHookCommandPaths, spaceFreePath } from "./codex-tui.js";
import { SLASH_COMMAND_NO_TURN } from "./prompt-submit.js";

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

  it("keeps a queue turn linked when the hook omits smart double quotes", async () => {
    const submitted: string[] = [];
    const manager = new CodexTuiManager("tab-smart-quotes", {
      submitPrompt: (_tabId: string, text: string) => { submitted.push(text); return true; },
      write: () => undefined,
    } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "new" }, hookScriptPath: "scripts/codex-hook.mjs" });
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-smart-quotes", cwd: "D:\\work", transcript_path: null });

    const starting = manager.rpc.startTurn("session-smart-quotes", "repair \u201cno progress\u201d state", "client-smart-quotes", "D:\\work");
    await vi.waitFor(() => expect(submitted).toEqual(["repair \u201cno progress\u201d state"]));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-smart-quotes", turn_id: "turn-smart-quotes", prompt: "repair no progress state" });

    await expect(starting).resolves.toEqual({ turnId: "turn-smart-quotes" });
    expect(manager.rpc.activeTurnIds("session-smart-quotes")).toEqual(["turn-smart-quotes"]);
    await manager.stop();
  });

  it("uses PostCompact to settle /compact without inventing a model turn", async () => {
    const submitted: string[] = [];
    const manager = new CodexTuiManager("tab-compact", {
      submitPrompt: (_tabId: string, text: string) => { submitted.push(text); return true; },
      write: () => undefined,
    } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "new" }, hookScriptPath: "scripts/codex-hook.mjs" });
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-compact", cwd: "D:\\work", transcript_path: null });

    const starting = manager.rpc.startTurn("session-compact", "/compact", "client-compact", "D:\\work");
    await vi.waitFor(() => expect(submitted).toEqual(["/compact"]));
    await manager.handleHook({ hook_event_name: "PostCompact", session_id: "session-compact" });

    await expect(starting).rejects.toThrow(SLASH_COMMAND_NO_TURN);
    expect(manager.rpc.activeTurnIds("session-compact")).toEqual([]);

    const accepted = manager.rpc.startTurn("session-compact", "/compact", "client-compact-accepted", "D:\\work");
    await vi.waitFor(() => expect(submitted).toEqual(["/compact", "/compact"]));
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-compact", turn_id: "turn-compact", prompt: "/compact" });
    expect((await accepted).turnId).toBe("turn-compact");
    await manager.handleHook({ hook_event_name: "PostCompact", session_id: "session-compact" });
    expect((await manager.rpc.waitForTurn("turn-compact")).turn.status).toBe("completed");
    await manager.stop();
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
    // The composer's own prompt marker carries no option number.
    expect(codexStartupQuestion("› Implement {feature}\n gpt-5.6-sol · Context 100% left")).toBeNull();
    // A short terminal can cut the screen in half. Either half still means
    // Codex is waiting, so half a question is reported without a name.
    expect(codexStartupQuestion("› 1. Review hooks\n  2. Trust all and continue")).toBe("Codex 启动提问");
    expect(codexStartupQuestion("  Press enter to confirm or esc to go back")).toBe("Codex 启动提问");
  });

  it("stops the clock while a question is on screen, and names it when it is never answered", async () => {
    const manager = new CodexTuiManager("tab-question", { write: () => undefined } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "new" }, hookScriptPath: "scripts/codex-hook.mjs" });
    const started = Date.now();
    // A 20ms budget would have expired long before this resolves; the question
    // has to hold it open for the reader, then hand back what to answer.
    const waiting = manager.waitForStartup(
      { startupError: () => null, question: () => codexStartupQuestion(hooksReview), ready: () => false },
      { timeoutMs: 20, questionTimeoutMs: 300, pollMs: 20 },
    );
    await expect(waiting).rejects.toThrow("CODEX_STARTUP_QUESTION_UNANSWERED:Hooks need review");
    expect(Date.now() - started).toBeGreaterThan(250);
  });

  it("starts as soon as the TUI is taking input, without waiting for a hook", async () => {
    // Codex creates the session -- and fires SessionStart -- only on the first
    // prompt, so a launch that waited for that hook could never finish.
    const manager = new CodexTuiManager("tab-ready", { write: () => undefined } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "new" }, hookScriptPath: "scripts/codex-hook.mjs" });
    let screen = hooksReview;
    setTimeout(() => { screen = "  >_ OpenAI Codex (v0.147.0)\n› Implement {feature}"; }, 120);
    await manager.waitForStartup(
      { startupError: () => null, question: () => codexStartupQuestion(screen), ready: () => codexTuiReady(screen) },
      { timeoutMs: 50, questionTimeoutMs: 5_000, settleMs: 60_000, pollMs: 20 },
    );
    expect(codexTuiReady(hooksReview)).toBe(false);
    expect(codexTuiReady(directoryTrust)).toBe(false);
    // The composer, which is what a short or narrow terminal is left showing.
    expect(codexTuiReady("› Implement {feature}")).toBe(true);
  });

  it("adopts a session whose id the caller already knows", async () => {
    const manager = new CodexTuiManager("tab-resume", { write: () => undefined } as any);
    await manager.beginLaunch({ cwd: "D:\\work", launch: { mode: "resume", sessionId: "thread-1" }, hookScriptPath: "scripts/codex-hook.mjs" });
    await manager.attachKnownSession({ sessionId: "thread-1", cwd: "D:\\work", transcriptPath: null, source: "resume" });
    expect((await manager.waitForSession(50)).sessionId).toBe("thread-1");
    expect(manager.session?.sessionId).toBe("thread-1");
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
