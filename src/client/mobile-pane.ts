/**
 * Phone layout paging. The desktop shell shows the console, the conversation,
 * the prompt queue and the terminal side by side; a phone shows exactly one of
 * them at full screen and pages between them left/right. This module holds the
 * pure part of that so the gesture thresholds can be tested without a DOM.
 */
export const MOBILE_PANES = ["console", "conversation", "queue", "terminal"] as const;

export type MobilePane = (typeof MOBILE_PANES)[number];

export type SwipeVector = { dx: number; dy: number };

/** Below this the gesture is a tap or a stray finger movement, not a page turn. */
export const SWIPE_MIN_DISTANCE = 56;
/** How much longer the horizontal leg must be before a swipe outranks a scroll. */
export const SWIPE_HORIZONTAL_RATIO = 1.4;

/**
 * -1 pages towards the console, 1 towards the terminal, 0 leaves the pane alone.
 * Anything that is short, or that leans vertical, is left to the pane's own
 * scroll region — flicking through answers must never turn the page.
 */
export function swipeDirection(
  vector: SwipeVector,
  minDistance: number = SWIPE_MIN_DISTANCE,
  horizontalRatio: number = SWIPE_HORIZONTAL_RATIO,
): -1 | 0 | 1 {
  const { dx, dy } = vector;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 0;
  if (Math.abs(dx) < minDistance) return 0;
  if (Math.abs(dx) < Math.abs(dy) * horizontalRatio) return 0;
  return dx < 0 ? 1 : -1;
}

/** The panes are a strip, not a carousel: paging stops at both ends. */
export function nextMobilePane(current: MobilePane, step: -1 | 0 | 1): MobilePane {
  const index = MOBILE_PANES.indexOf(current);
  if (index < 0 || step === 0) return current;
  return MOBILE_PANES[Math.min(MOBILE_PANES.length - 1, Math.max(0, index + step))];
}
