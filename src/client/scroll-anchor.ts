/**
 * Whether a scrolling list should follow new content or stay where it is.
 *
 * These lists used to jump to the bottom on every change, which is right only
 * when the reader was already there. If they had scrolled up to read an older
 * turn, a prompt finishing somewhere else yanked the view out from under them
 * -- worst on a phone, where the pane is the whole screen and there is nowhere
 * to look away to.
 */
export type ScrollPosition = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Close enough to the bottom that the reader means to be following along. */
export const BOTTOM_SLACK = 24;
/** Close enough to the top to be asking for the previous page. */
export const TOP_TRIGGER = 48;
/** Fractional scroll positions are common under browser zoom and trackpads. */
export const SCROLL_EDGE_EPSILON = 1;

export function isAtBottom({ scrollTop, scrollHeight, clientHeight }: ScrollPosition, slack = BOTTOM_SLACK): boolean {
  if (![scrollTop, scrollHeight, clientHeight].every((value) => Number.isFinite(value))) return true;
  // A list shorter than its pane has nowhere to scroll, so it is always at the
  // bottom -- and must keep following, or short conversations would freeze.
  return scrollHeight - clientHeight - scrollTop <= Math.max(0, slack);
}

export function isNearTop({ scrollTop }: Pick<ScrollPosition, "scrollTop">, trigger = TOP_TRIGGER): boolean {
  return Number.isFinite(scrollTop) && scrollTop <= Math.max(0, trigger);
}

/**
 * Whether a nested scroller has exhausted the direction of the current wheel
 * gesture and should hand that gesture to its containing pane.
 *
 * This is intentionally direction-specific: being at the bottom must not stop
 * an upward wheel gesture from scrolling the prompt text itself, and vice
 * versa. A box with no internal overflow hands both directions outward.
 */
export function shouldHandoffWheel(
  { scrollTop, scrollHeight, clientHeight }: ScrollPosition,
  deltaY: number,
  epsilon = SCROLL_EDGE_EPSILON,
): boolean {
  if (![scrollTop, scrollHeight, clientHeight, deltaY].every(Number.isFinite) || deltaY === 0) return false;
  const edgeSlack = Math.max(0, epsilon);
  const maximum = Math.max(0, scrollHeight - clientHeight);
  return deltaY < 0
    ? scrollTop <= edgeSlack
    : scrollTop >= maximum - edgeSlack;
}

/** Converts WheelEvent line/page deltas to the pixels used by scrollTop. */
export function wheelDeltaPixels(deltaY: number, deltaMode: number, lineHeight: number, pageHeight: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 1) return deltaY * (Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 16);
  if (deltaMode === 2) return deltaY * (Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 1);
  return deltaY;
}
