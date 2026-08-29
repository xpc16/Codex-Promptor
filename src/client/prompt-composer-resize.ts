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
