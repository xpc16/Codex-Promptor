/**
 * What a terminal subscription should do when the page is hidden or shown.
 *
 * A hidden page still receives every byte the agent writes, and the browser
 * stops firing `requestAnimationFrame` while it is hidden -- which is what the
 * terminal write queue yields on between chunks. So the backlog piles up and
 * is replayed frame by frame on return: the terminal visibly fast-forwards
 * through everything that was missed instead of showing where it ended up.
 *
 * Dropping the stream while nobody is looking removes the backlog entirely,
 * and the bounded catch-up on return lets the server decide: a short absence
 * streams the few missed bytes, a long one exceeds the cap and comes back as
 * one screen snapshot.
 */
export type TerminalVisibilityAction = "none" | "unsubscribe" | "resubscribe";

export function terminalVisibilityAction(input: {
  hidden: boolean;
  /** Already hidden behind an open document, which owns the subscription. */
  documentVisible: boolean;
  /** Projection mode sends screen diffs, so there is no backlog to replay. */
  projectionMode: boolean;
  /** The panel of a tab the reader is not looking at holds no socket. */
  active: boolean;
}): TerminalVisibilityAction {
  if (!input.active || input.documentVisible) return "none";
  if (input.hidden) return "unsubscribe";
  // Projection resubscribes too: its frames stopped arriving with the rest.
  return "resubscribe";
}
