/**
 * How much of a conversation crosses the wire before the reader asks for more.
 *
 * Final answers are the heavy records: in this workspace the `finalAnswer`
 * text alone is about two thirds of every stored answer byte, and the answer
 * file outweighs the prompt file for the same conversation. So opening a tab
 * ships only the last few turns and pages backwards on demand.
 */
export const INITIAL_ANSWER_WINDOW = 3;
export const INITIAL_PROMPT_WINDOW = 24;

/** How many older records one scroll-back request pulls in. */
export const EARLIER_ANSWER_PAGE = 10;
export const EARLIER_PROMPT_PAGE = 50;

/** Ceiling for any single read, however deep the reader has scrolled. */
export const MAX_WINDOW_RECORDS = 500;

/**
 * Where a tail window starts.
 *
 * `pinned` holds indexes that must stay inside the window whatever the limit
 * says -- the turn currently running, and the first prompt still waiting to
 * run. Pending prompts are the queue's actionable content and reordering them
 * requires the complete set, so they are pinned rather than paged. The hard
 * cap still applies: an unusually long queue must not turn the first read back
 * into a full history dump.
 */
export function tailWindowStart(
  total: number,
  limit: number,
  pinned: readonly number[] = [],
  hardCap = MAX_WINDOW_RECORDS,
): number {
  const cap = Math.max(1, Math.trunc(hardCap));
  const size = Math.max(1, Math.min(cap, Math.trunc(Number(limit)) || 1));
  let start = Math.max(0, total - size);
  for (const index of pinned) {
    if (!Number.isFinite(index) || index < 0) continue;
    start = Math.min(start, Math.trunc(index));
  }
  return Math.max(0, Math.max(start, total - cap));
}

/**
 * The limit that reproduces a window the reader has already scrolled open, so
 * a refresh does not collapse the view back to the opening few records and
 * make them fetch the same history a second time.
 */
export function retainedWindowLimit(start: number, total: number, minimum: number): number {
  const loaded = Math.max(0, Math.trunc(total)) - Math.max(0, Math.trunc(start));
  return Math.max(minimum, Math.min(MAX_WINDOW_RECORDS, Number.isFinite(loaded) ? loaded : minimum));
}
