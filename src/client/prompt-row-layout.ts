export type PromptActionLayoutMetrics = {
  hasHardLineBreak: boolean;
  textWidth: number;
  fullWidth: number;
  actionWidth: number;
  gap: number;
};

/**
 * Keeps a short prompt and its controls on one line, then gives the prompt the
 * whole content column once its natural width would touch those controls.
 *
 * The decision deliberately uses the full row width rather than the textarea's
 * current laid-out width. That makes it stable after the controls move below:
 * expanding the textarea cannot immediately reverse the decision and cause a
 * ResizeObserver feedback loop.
 */
export function promptActionsNeedOwnRow({ hasHardLineBreak, textWidth, fullWidth, actionWidth, gap }: PromptActionLayoutMetrics): boolean {
  if (hasHardLineBreak) return true;
  if (![textWidth, fullWidth, actionWidth, gap].every(Number.isFinite)) return true;
  const inlineTextWidth = Math.max(0, fullWidth - Math.max(0, actionWidth) - Math.max(0, gap));
  return Math.max(0, textWidth) >= inlineTextWidth;
}
