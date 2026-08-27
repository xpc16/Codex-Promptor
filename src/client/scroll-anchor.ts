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

export function isAtBottom({ scrollTop, scrollHeight, clientHeight }: ScrollPosition, slack = BOTTOM_SLACK): boolean {
  if (![scrollTop, scrollHeight, clientHeight].every((value) => Number.isFinite(value))) return true;
  // A list shorter than its pane has nowhere to scroll, so it is always at the
  // bottom -- and must keep following, or short conversations would freeze.
  return scrollHeight - clientHeight - scrollTop <= Math.max(0, slack);
}

export function isNearTop({ scrollTop }: Pick<ScrollPosition, "scrollTop">, trigger = TOP_TRIGGER): boolean {
  return Number.isFinite(scrollTop) && scrollTop <= Math.max(0, trigger);
}
