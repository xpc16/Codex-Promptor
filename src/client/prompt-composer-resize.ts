export const PROMPT_COMPOSER_MIN_HEIGHT = 50;
export const PROMPT_COMPOSER_MAX_HEIGHT = 420;
export const PROMPT_COMPOSER_MAX_VIEWPORT_RATIO = 0.45;

export function clampPromptComposerHeight(height: number, viewportHeight: number): number {
  const viewportMaximum = Number.isFinite(viewportHeight)
    ? viewportHeight * PROMPT_COMPOSER_MAX_VIEWPORT_RATIO
    : PROMPT_COMPOSER_MAX_HEIGHT;
  const maximum = Math.max(PROMPT_COMPOSER_MIN_HEIGHT, Math.min(PROMPT_COMPOSER_MAX_HEIGHT, viewportMaximum));
  return Math.min(maximum, Math.max(PROMPT_COMPOSER_MIN_HEIGHT, height));
}

/** Moving the top edge upward increases height while the bottom stays fixed. */
export function draggedPromptComposerHeight(startHeight: number, startY: number, currentY: number, viewportHeight: number): number {
  return clampPromptComposerHeight(startHeight + startY - currentY, viewportHeight);
}

/**
 * The height the composer was last dragged to, for this page.
 *
 * The queue remounts whenever the selected conversation or its thread changes
 * -- and opening a conversation changes its thread -- so a height that lived
 * only in the DOM was undone by the very next click. One value for the page
 * rather than one per conversation: "I want a taller input box" is a
 * preference about the layout, not about a conversation.
 *
 * In memory only, the same lifetime as a composer draft: it lasts as long as
 * the page and is not written to disk.
 */
let preferredHeight: number | null = null;

export function rememberPromptComposerHeight(height: number): void {
  preferredHeight = height;
}

/** The remembered height, clamped to this viewport, or null if none was set. */
export function rememberedPromptComposerHeight(viewportHeight: number): number | null {
  return preferredHeight === null ? null : clampPromptComposerHeight(preferredHeight, viewportHeight);
}

/** Test seam: the page-wide store would otherwise leak between cases. */
export function forgetPromptComposerHeight(): void {
  preferredHeight = null;
}
