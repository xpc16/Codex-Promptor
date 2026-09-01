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

/**
 * What to do with a keystroke while the terminal subscription may be away.
 *
 * The subscription is no longer permanent: it is dropped while the page is
 * hidden, and again for the moment a screen snapshot replaces a replay. Input
 * that crossed either gap came back as "Subscribe to the terminal before
 * sending input" -- an error about the transport, thrown at a reader who had
 * only pressed a key.
 *
 * A snapshot already on its way is the one case not to ask again: the stream it
 * is generated from was retired on purpose, and resubscribing now would undo
 * that. It puts the subscription back itself when it lands.
 */
export type TerminalInputDisposition = "send" | "hold" | "hold-and-resubscribe" | "drop";

export function terminalInputDisposition(input: {
  subscribed: boolean;
  /** Whether this page should be subscribed at all right now. */
  wanted: boolean;
  /** A screen snapshot was requested and has not arrived yet. */
  snapshotInFlight: boolean;
}): TerminalInputDisposition {
  if (input.subscribed) return "send";
  // Nothing is coming back for a page nobody is looking at.
  if (!input.wanted) return "drop";
  return input.snapshotInFlight ? "hold" : "hold-and-resubscribe";
}
