/**
 * Pane widths belong to the screen you are looking at, not to the conversation.
 * The console width and the workspace splitter are therefore kept in this
 * browser's own storage rather than in the shared index file: a phone and a
 * desktop viewing the same session each keep their own layout, and dragging a
 * divider on one no longer shoves the other's around. localStorage is
 * per-origin, so the local address and the tunnel hostname are separate by
 * construction.
 */
export type PaneStore = Pick<Storage, "getItem" | "setItem">;

export type PaneSizeSpec = { key: string; fallback: number; min: number; max: number };

const KEY_PREFIX = "promptor.pane.";

export const CONSOLE_WIDTH: PaneSizeSpec = { key: `${KEY_PREFIX}console-width`, fallback: 300, min: 220, max: 520 };

/** One entry per conversation: the split that suits a long answer is not the one that suits a long queue. */
export function workspaceSplit(tabId: string, fallback: number): PaneSizeSpec {
  return { key: `${KEY_PREFIX}split.${tabId}`, fallback, min: 24, max: 76 };
}

/**
 * How much of the conversation column the session card takes.
 *
 * Unset until the reader drags it, so a conversation that needs three lines of
 * session detail still gets three lines rather than a third of the column.
 */
export function conversationSplit(tabId: string): PaneSizeSpec {
  return { key: `${KEY_PREFIX}session.${tabId}`, fallback: 38, min: 12, max: 80 };
}

/**
 * How much of the right column belongs to the prompt queue.
 *
 * Like the other pane dimensions, this is intentionally browser-local. A
 * tunnel viewer can make room for a phone-sized terminal without changing the
 * layout seen at the loopback URL on the workstation.
 */
export function queueTerminalSplit(tabId: string): PaneSizeSpec {
  return { key: `${KEY_PREFIX}queue-terminal.${tabId}`, fallback: 54, min: 20, max: 80 };
}

export function clampPaneSize(value: number, spec: PaneSizeSpec): number {
  if (!Number.isFinite(value)) return spec.fallback;
  return Math.max(spec.min, Math.min(spec.max, value));
}

/** Storage throws in some privacy modes, and a layout preference is never worth an exception. */
export function browserPaneStore(): PaneStore | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

/** null when this browser has never been told, so a caller can keep its own default. */
export function readStoredPaneSize(spec: PaneSizeSpec, store: PaneStore | null = browserPaneStore()): number | null {
  if (!store) return null;
  try {
    const raw = store.getItem(spec.key);
    if (raw === null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? clampPaneSize(value, spec) : null;
  } catch { return null; }
}

export function readPaneSize(spec: PaneSizeSpec, store: PaneStore | null = browserPaneStore()): number {
  return readStoredPaneSize(spec, store) ?? spec.fallback;
}

export function writePaneSize(spec: PaneSizeSpec, value: number, store: PaneStore | null = browserPaneStore()): void {
  if (!store) return;
  try { store.setItem(spec.key, String(Math.round(clampPaneSize(value, spec)))); }
  catch { /* quota or a disabled store; the layout simply is not remembered */ }
}
