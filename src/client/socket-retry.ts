/**
 * When a dropped terminal socket is worth telling the reader about.
 *
 * A WebSocket reports an error for any abnormal close, and the terminal
 * reconnects on its own within a second, so a single drop is not news -- the
 * connection the reader is looking at is working. Raising a toast for each one
 * produced a steady stream of failure notices about a connection that was
 * fine. This holds the alarm until the reconnects have actually stopped
 * working, and clears it the moment one succeeds.
 */
export const FAILURES_BEFORE_ALERT = 3;

export type ConnectionAlarm = {
  /** True exactly once per outage, when the failures cross the threshold. */
  noteFailure(): boolean;
  noteSuccess(): void;
  failures(): number;
};

export function createConnectionAlarm(threshold = FAILURES_BEFORE_ALERT): ConnectionAlarm {
  const limit = Math.max(1, Math.trunc(threshold));
  let failures = 0;
  let raised = false;
  return {
    noteFailure() {
      failures += 1;
      if (raised || failures < limit) return false;
      raised = true;
      return true;
    },
    noteSuccess() { failures = 0; raised = false; },
    failures() { return failures; },
  };
}

export const RECONNECT_BASE_MS = 750;
export const RECONNECT_MAX_MS = 15_000;

/**
 * How long to wait before the next attempt.
 *
 * The first retry is immediate enough to be invisible; a server that keeps
 * refusing -- a terminal stream closed for backpressure, say -- then gets
 * progressively more room instead of the same 750ms hammering that helped
 * cause the backpressure.
 */
export function reconnectDelay(failures: number, base = RECONNECT_BASE_MS, max = RECONNECT_MAX_MS): number {
  const attempt = Math.max(1, Math.trunc(failures));
  return Math.min(max, base * 2 ** (attempt - 1));
}
