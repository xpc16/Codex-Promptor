/**
 * Recovering a prompt that was typed into an agent TUI but never submitted.
 *
 * Promptor injects queued prompts by writing them into the real terminal, so
 * "submitted" is only known once the agent's own hook reports it back. When the
 * Enter is dropped -- the TUI was mid-repaint, or busy reflowing after another
 * viewer resized the shared terminal -- the text sits visibly in the input box
 * and nothing else happens. Re-sending Enter recovers that instead of failing
 * the queue and making the user press it by hand.
 */
export const SUBMIT_TIMEOUT_MS = 20_000;

/**
 * When to re-send Enter, in ms after the prompt text went out.
 *
 * The first attempt used to be at 1.5s, which is inside the window a hook
 * routinely takes to come back. A merely slow hook therefore looked identical
 * to a dropped Enter, and the resend submitted a prompt that had already gone
 * -- two `UserPromptSubmit` for one submission, which is what left the queue
 * unable to match either of them. Recovery now starts after that window.
 */
export const SUBMIT_RETRY_DELAYS_MS: readonly number[] = [4_000, 9_000];

export type SubmitTimers = {
  retries: ReturnType<typeof setTimeout>[];
  timeout: ReturnType<typeof setTimeout>;
};

/**
 * `resend` fires only while the submission is still unacknowledged, so a stray
 * Enter can only reach an input box the agent told us it never read. Enter on
 * an empty box is a no-op in both Claude Code and Cursor; the alternative is a
 * guaranteed failed turn.
 */
export function scheduleSubmitRecovery(
  resend: () => void,
  giveUp: () => void,
  delays: readonly number[] = SUBMIT_RETRY_DELAYS_MS,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
): SubmitTimers {
  return {
    retries: delays.filter((delay) => delay < timeoutMs).map((delay) => setTimeout(resend, delay)),
    timeout: setTimeout(giveUp, timeoutMs),
  };
}

export function clearSubmitTimers(timers: SubmitTimers): void {
  for (const retry of timers.retries) clearTimeout(retry);
  clearTimeout(timers.timeout);
}
