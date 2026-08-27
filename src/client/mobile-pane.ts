/**
 * Phone layout paging. The desktop shell shows the console, the conversation,
 * the prompt queue and the terminal side by side; a phone shows exactly one of
 * them at full screen.
 *
 * Moving between them is the bar at the bottom and nothing else. A sideways
 * swipe used to page as well, and it kept firing on gestures meant for the
 * content -- dragging a queue row, panning the terminal, flicking through a
 * wide answer -- so the page turned out from under whatever the finger was
 * actually doing. A control that is always in the same place is worth more
 * here than a shortcut that has to guess.
 */
export const MOBILE_PANES = ["console", "conversation", "queue", "terminal"] as const;

export type MobilePane = (typeof MOBILE_PANES)[number];

export function isMobilePane(value: unknown): value is MobilePane {
  return typeof value === "string" && (MOBILE_PANES as readonly string[]).includes(value);
}
