/**
 * Conservative recovery for a prompt injected into an agent TUI.
 *
 * PTY writes have no acknowledgement. Hooks are the fast acknowledgement, but
 * they are intentionally best-effort; the provider transcript is therefore
 * checked before an Enter is ever repeated. An unreadable/unknown transcript
 * is not evidence that submission failed.
 */
export const SUBMIT_TIMEOUT_MS = 20_000;
export const SUBMIT_RETRY_DELAYS_MS: readonly number[] = [4_000, 9_000];
export const SUBMIT_RECONCILE_INTERVAL_MS = 5_000;
/**
 * Slash commands are handled by the CLI itself and do not necessarily create
 * a provider turn or final answer. This internal result lets the queue settle
 * that expected no-turn case without mistaking it for a failed model prompt.
 */
export const SLASH_COMMAND_NO_TURN = "SLASH_COMMAND_NO_TURN";

export function isSlashCommandPrompt(text: string): boolean {
  return text.trimStart().startsWith("/");
}

export type SubmitEvidence =
  | { state: "accepted"; turnId: string; turn?: any; items?: any[] }
  | { state: "not-submitted" }
  | { state: "unknown"; reason?: string };

export type SubmitTimers = {
  retries: ReturnType<typeof setTimeout>[];
  timeout: ReturnType<typeof setTimeout>;
  reconcile: ReturnType<typeof setInterval> | null;
  stopped: boolean;
};

export type SubmitRecoveryOptions = {
  /** Read only the provider-owned record written since this submission began. */
  inspect: () => Promise<SubmitEvidence>;
  /** Repeat Enter only after the record positively says no user turn exists. */
  resend: () => void;
  /** Hook-equivalent acknowledgement reconstructed from the provider record. */
  accept: (evidence: Extract<SubmitEvidence, { state: "accepted" }>) => void;
  /** The deadline expired without either positive or negative evidence. */
  unconfirmed?: (evidence: Extract<SubmitEvidence, { state: "unknown" }>) => void;
};

/**
 * Schedule two evidence-gated Enter retries and then low-frequency accounting.
 *
 * At 20 seconds an unknown result normally remains pending and is reconciled
 * in the background. Providers may instead settle an expected no-turn CLI
 * command from `unconfirmed`; ordinary prompts are deliberately not failed. An
 * unchanged record is enough to gate an Enter retry, but not enough to prove
 * the CLI rejected the submission. Explicit process exit is handled directly
 * by each provider manager.
 */
export function scheduleSubmitRecovery(
  options: SubmitRecoveryOptions,
  delays: readonly number[] = SUBMIT_RETRY_DELAYS_MS,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
  reconcileIntervalMs: number = SUBMIT_RECONCILE_INTERVAL_MS,
): SubmitTimers {
  const timers: SubmitTimers = { retries: [], timeout: undefined as never, reconcile: null, stopped: false };
  let inspection: Promise<SubmitEvidence> | null = null;

  const inspect = async (): Promise<SubmitEvidence> => {
    if (inspection) return inspection;
    inspection = options.inspect().catch((error) => ({
      state: "unknown" as const,
      reason: error instanceof Error ? error.message : String(error),
    }));
    try { return await inspection; }
    finally { inspection = null; }
  };

  const settleFromEvidence = (evidence: SubmitEvidence): boolean => {
    if (timers.stopped || evidence.state !== "accepted") return false;
    clearSubmitTimers(timers);
    options.accept(evidence);
    return true;
  };

  const retry = async (): Promise<void> => {
    if (timers.stopped) return;
    const evidence = await inspect();
    if (settleFromEvidence(evidence)) return;
    if (evidence.state === "not-submitted") options.resend();
  };

  const reconcile = async (): Promise<void> => {
    if (timers.stopped) return;
    const evidence = await inspect();
    settleFromEvidence(evidence);
  };

  timers.retries = delays
    .filter((delay) => delay > 0 && delay < timeoutMs)
    .map((delay) => setTimeout(() => { void retry(); }, delay));
  timers.timeout = setTimeout(() => {
    void (async () => {
      if (timers.stopped) return;
      const evidence = await inspect();
      if (settleFromEvidence(evidence)) return;
      options.unconfirmed?.(evidence.state === "unknown"
        ? evidence
        : { state: "unknown", reason: "PERSISTENT_RECORD_HAS_NO_USER_TURN" });
      if (!timers.stopped && reconcileIntervalMs > 0) {
        timers.reconcile = setInterval(() => { void reconcile(); }, reconcileIntervalMs);
        timers.reconcile.unref?.();
      }
    })();
  }, timeoutMs);
  for (const retryTimer of timers.retries) retryTimer.unref?.();
  timers.timeout.unref?.();
  return timers;
}

export function clearSubmitTimers(timers: SubmitTimers): void {
  if (timers.stopped) return;
  timers.stopped = true;
  for (const retry of timers.retries) clearTimeout(retry);
  clearTimeout(timers.timeout);
  if (timers.reconcile) clearInterval(timers.reconcile);
  timers.reconcile = null;
}

/**
 * Characters a TUI paste is known to give back unchanged: ASCII, CJK, and
 * CJK/fullwidth punctuation.
 *
 * Everything outside it has been observed to disappear somewhere between the
 * PTY and the provider transcript -- a U+2192 arrow and a U+222B integral
 * sign, both silently. Curly quotes belong here too, which is why the
 * comparison below already had to strip them.
 */
const SURVIVES_A_PASTE = /[\t\n\r\x20-\x7E\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]/;

/** The distinct characters in `text` that a paste may not give back. */
export function charactersAPasteMayDrop(text: string): string[] {
  const offending = new Set<string>();
  for (const character of text) if (!SURVIVES_A_PASTE.test(character)) offending.add(character);
  return [...offending];
}

/**
 * Limited normalization only: never substring- or fuzzy-match user text.
 *
 * Beyond line endings, the one thing removed is characters the terminal may
 * not hand back, and they are removed from *both* sides -- so this is not
 * fuzziness, it is undoing a known, symmetric transport loss. Without it a
 * prompt containing one of them can never be acknowledged: the queue sits in
 * `dispatching` forever while the answer is written above it, and history
 * sync imports the CLI's version as a second prompt.
 */
export function sameSubmittedPrompt(left: string, right: string): boolean {
  const comparable = (value: string) => {
    let out = "";
    for (const character of value.replace(/\r\n/g, "\n")) if (SURVIVES_A_PASTE.test(character)) out += character;
    return out.trim();
  };
  return comparable(left) === comparable(right);
}
