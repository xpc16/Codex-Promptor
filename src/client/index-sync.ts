/**
 * Reconciling a navigation index pushed from the server.
 *
 * Every viewer — the local browser and any remote one — reads the same index
 * file, so renames, deletions, group moves and reordering arrive over the
 * WebSocket rather than only from this page's own requests. Adopting one
 * blindly would fight whatever the user is doing here, so the decisions live
 * in this module where they can be tested without a DOM.
 */
export type IndexDialogTarget =
  | { kind: "group" }
  | { kind: "rename-tab"; tabId: string }
  | { kind: "rename-group"; groupId: string }
  | { kind: "delete-tab"; tabId: string }
  | { kind: "delete-group"; groupId: string };

/**
 * The server bumps `revision` on every index write, so it orders changes. A
 * reconnect replays the current index and a slow socket can deliver a write
 * out of order; neither may undo a newer view. Equal revisions are re-applied
 * because a forced refresh has to be able to resync a locally corrupted view.
 */
export function shouldAdoptIndexRevision(nextRevision: number, appliedRevision: number): boolean {
  if (!Number.isFinite(nextRevision)) return false;
  return nextRevision >= appliedRevision;
}

/** Keep the open conversation unless it just disappeared from under us. */
export function nextSelectedTabId(current: string | null, tabIds: readonly string[]): string | null {
  if (current && tabIds.includes(current)) return current;
  return tabIds[0] ?? null;
}

/**
 * A rename or delete dialog whose subject was removed elsewhere would submit
 * against a missing id and surface a 404 the user cannot act on. Close it
 * instead; "new group" has no subject and always survives.
 */
export function dialogSurvivesIndex(
  dialog: IndexDialogTarget | null,
  tabIds: readonly string[],
  groupIds: readonly string[],
): boolean {
  if (!dialog) return true;
  if (dialog.kind === "group") return true;
  if (dialog.kind === "rename-tab" || dialog.kind === "delete-tab") return tabIds.includes(dialog.tabId);
  return groupIds.includes(dialog.groupId);
}
