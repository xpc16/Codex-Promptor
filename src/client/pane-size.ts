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

export function clampPaneSize(value: number, spec: PaneSizeSpec): number {
  if (!Number.isFinite(value)) return spec.fallback;
  return Math.max(spec.min, Math.min(spec.max, value));
}

/** Storage throws in some privacy modes, and a layout preference is never worth an exception. */
export function browserPaneStore(): PaneStore | null {
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function readPaneSize(spec: PaneSizeSpec, store: PaneStore | null = browserPaneStore()): number {
  if (!store) return spec.fallback;
  try {
    const raw = store.getItem(spec.key);
    if (raw === null) return spec.fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? clampPaneSize(value, spec) : spec.fallback;
  } catch { return spec.fallback; }
}

export function writePaneSize(spec: PaneSizeSpec, value: number, store: PaneStore | null = browserPaneStore()): void {
  if (!store) return;
  try { store.setItem(spec.key, String(Math.round(clampPaneSize(value, spec)))); }
  catch { /* quota or a disabled store; the layout simply is not remembered */ }
}
