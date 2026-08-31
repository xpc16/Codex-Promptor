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
 * At 20 seconds an unknown result remains pending and is reconciled in the
 * background. It is deliberately not turned into a failed queue prompt. An
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

/** Limited normalization only: never substring- or fuzzy-match user text. */
export function sameSubmittedPrompt(left: string, right: string): boolean {
  return left.replace(/\r\n/g, "\n").trim() === right.replace(/\r\n/g, "\n").trim();
}
