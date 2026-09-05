import { describe, expect, it } from "vitest";
import { isInjectedClaudePrompt } from "./claude-injected-prompt.js";

describe("text Claude writes as a user turn that nobody typed", () => {
  it("recognises a finished background command", () => {
    // The one that was reaching the history: one manual conversation per
    // background command that finished.
    expect(isInjectedClaudePrompt("<task-notification>\n<task-id>b2oicv3dq</task-id>\n</task-notification>")).toBe(true);
  });

  it("recognises the notification that carries a preamble instead", () => {
    expect(isInjectedClaudePrompt("[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event")).toBe(true);
  });

  it("recognises reminders, local command echoes and the compaction preamble", () => {
    expect(isInjectedClaudePrompt("<system-reminder>context</system-reminder>")).toBe(true);
    expect(isInjectedClaudePrompt("<local-command-caveat>ran locally</local-command-caveat>")).toBe(true);
    expect(isInjectedClaudePrompt("<local-command-stdout>output</local-command-stdout>")).toBe(true);
    expect(isInjectedClaudePrompt("<local-command-stderr>oops</local-command-stderr>")).toBe(true);
    expect(isInjectedClaudePrompt("This session is being continued from a previous conversation that ran out of context.")).toBe(true);
  });

  it("tolerates the leading whitespace a record can carry", () => {
    expect(isInjectedClaudePrompt("\n  <task-notification>\n</task-notification>")).toBe(true);
  });

  it("keeps a prompt that only quotes one of these", () => {
    // Asking about a notification is a real prompt. Only text that begins as
    // the injection is the injection, which is why the match is anchored.
    expect(isInjectedClaudePrompt("为什么会出现 <task-notification> 这种东西")).toBe(false);
    expect(isInjectedClaudePrompt("explain <system-reminder> blocks")).toBe(false);
  });

  it("keeps ordinary prompts", () => {
    expect(isInjectedClaudePrompt("run the tests")).toBe(false);
    expect(isInjectedClaudePrompt("")).toBe(false);
    expect(isInjectedClaudePrompt("<div>not one of ours</div>")).toBe(false);
  });
});
