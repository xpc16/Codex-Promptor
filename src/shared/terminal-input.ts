/**
 * The compact form of a keystroke.
 *
 * Measured over a day on one tunnel: 21,759 input messages, 92 bytes each,
 * 86% of everything the browser sent upstream, compressing 1.03x. A single
 * typed character was carried by a 36-byte tab id, a 24-byte message type and
 * a base64 wrapper that turns one byte into four.
 *
 * The tab id becomes a prefix the receiver resolves against that sender's own
 * subscriptions, so a handle can never address a terminal the sender is not
 * already attached to, and printable text rides in the JSON string rather than
 * through base64.
 */
export const TERMINAL_INPUT_COMPACT_TYPE = "ti";
export const TERMINAL_INPUT_HANDLE_LENGTH = 8;

export function terminalInputHandle(tabId: string): string {
  return tabId.slice(0, TERMINAL_INPUT_HANDLE_LENGTH);
}

/** The one subscribed id this handle names, or null if it names none or several. */
export function resolveTerminalInputHandle(handle: unknown, tabIds: Iterable<string>): string | null {
  if (typeof handle !== "string" || handle.length === 0) return null;
  let found: string | null = null;
  for (const tabId of tabIds) {
    if (!tabId.startsWith(handle)) continue;
    // Two terminals behind one handle: never guess which one to type into.
    if (found) return null;
    found = tabId;
  }
  return found;
}

/**
 * Whether text costs less inside a JSON string than base64 would charge.
 *
 * Control characters escape to six characters each, which is worse than the
 * four base64 spends, so escape sequences keep taking the base64 route.
 */
export function terminalInputIsPlain(data: string): boolean {
  return !/[\u0000-\u001f\u007f]/u.test(data);
}
