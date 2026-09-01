/**
 * Whether a terminal stream should be subscribed right now.
 *
 * A hidden page still receives every byte the agent writes, and the browser
 * stops firing `requestAnimationFrame` while it is hidden -- which is what the
 * terminal write queue yields on between chunks. So the backlog piles up and is
 * replayed frame by frame on return: the terminal visibly fast-forwards through
 * everything that was missed instead of showing where it ended up.
 *
 * This is deliberately a state and not a transition. Driving the subscription
 * from visibility *changes* meant a page that opened while hidden, or that
 * missed the event turning it visible again, sat there unsubscribed with no way
 * back -- a terminal that never loaded until something else happened to
 * resubscribe it. Comparing the wanted state against what was last sent
 * recovers from any missed event, on the next one that does arrive.
 */
export function terminalSubscriptionWanted(input: {
  /** document.visibilityState === "hidden". */
  hidden: boolean;
  /** An open document owns the subscription; it re-enters through its own path. */
  documentVisible: boolean;
  /** The panel of a tab the reader is not looking at holds no socket. */
  active: boolean;
}): boolean {
  return input.active && !input.documentVisible && !input.hidden;
}
