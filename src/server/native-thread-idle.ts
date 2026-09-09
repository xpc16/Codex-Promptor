import type { EventEmitter } from "node:events";

/** Hooks wake the waiter immediately; bounded local transcript reads recover
 * a lost Stop hook, including for manual turns that have no waitForTurn caller. */
export async function waitForNativeThreadIdle(
  events: EventEmitter,
  isBusy: () => boolean,
  reconcile: () => Promise<void>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextReconcile = Date.now() + 5_000;
  while (isBusy()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("THREAD_IDLE_TIMEOUT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, Math.min(remaining, Math.max(1, nextReconcile - Date.now())));
      function done() {
        clearTimeout(timer);
        events.removeListener("turnCompleted", done);
        resolve();
      }
      events.once("turnCompleted", done);
    });
    if (!isBusy()) return;
    if (Date.now() >= nextReconcile || Date.now() >= deadline) {
      await reconcile();
      nextReconcile = Date.now() + 5_000;
    }
    // Recheck busy before checking the deadline: completion can land at the
    // timeout boundary, or be recovered by the last transcript read.
  }
}
