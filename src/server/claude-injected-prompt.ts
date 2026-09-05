/**
 * Text Claude Code puts into a conversation as a user turn that no human typed.
 *
 * Background-task notifications, system reminders, local command output and the
 * compaction preamble are all written as user-role records, and each one fires
 * the `UserPromptSubmit` hook exactly as a typed prompt does. Promptor records a
 * turn with no queue submission behind it as a manual one, so every finished
 * background command left a hand-typed conversation in the history.
 *
 * The transcript reader has always dropped these. The hook path had not, and
 * the hook is what creates the turn while the session is live -- so both now
 * ask the same question here rather than keeping two lists of markers that can
 * drift apart.
 */

/**
 * Anchored deliberately. A reader asking about one of these blocks quotes it
 * inside a sentence of their own, and that is a real prompt; only text that
 * *begins* as the injection is the injection.
 */
const INJECTED_PROMPT_RE = /^(?:<(?:task-notification|system-reminder|local-command-(?:caveat|stdout|stderr))\b|\[SYSTEM NOTIFICATION - NOT USER INPUT\]|This session is being continued from a previous conversation that ran out of context\.)/i;

export function isInjectedClaudePrompt(value: string): boolean {
  return INJECTED_PROMPT_RE.test(value.trim());
}
