/**
 * How tall a queue row's text box should be.
 *
 * A row used to size itself by counting newlines, which is not what the reader
 * sees: one long prompt with no line breaks counted as a single line and got a
 * one-line box however far it wrapped. Measuring the laid-out height instead
 * means a one-line prompt gets one line, a two-line prompt gets two, and
 * anything longer stops at the cap and scrolls inside its own box so the
 * queue stays scannable.
 */
export const PROMPT_ROW_MAX_LINES = 3;

export type TextareaMetrics = {
  /** Natural laid-out height at the current width, including padding. */
  scrollHeight: number;
  lineHeight: number;
  /** Padding above plus below. */
  padding: number;
  /** Border above plus below; counted because the box is border-box sized. */
  border: number;
  maxLines?: number;
};

export function autoSizedHeight({ scrollHeight, lineHeight, padding, border, maxLines = PROMPT_ROW_MAX_LINES }: TextareaMetrics): number {
  const cap = Math.max(1, Math.trunc(maxLines));
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return Math.max(0, scrollHeight) + Math.max(0, border);
  const content = Math.max(0, (Number.isFinite(scrollHeight) ? scrollHeight : 0) - Math.max(0, padding));
  const lines = Math.min(cap, Math.max(1, Math.round(content / lineHeight)));
  return Math.round(lines * lineHeight + Math.max(0, padding) + Math.max(0, border));
}

/** The vertical metrics of a laid-out text box, read once per measurement. */
export function readTextareaMetrics(element: HTMLTextAreaElement, maxLines = PROMPT_ROW_MAX_LINES): TextareaMetrics {
  const style = getComputedStyle(element);
  const fontSize = Number.parseFloat(style.fontSize);
  const parsedLineHeight = Number.parseFloat(style.lineHeight);
  return {
    scrollHeight: element.scrollHeight,
    // `line-height: normal` does not parse; fall back to the ratio the sheet uses.
    lineHeight: Number.isFinite(parsedLineHeight) ? parsedLineHeight : (Number.isFinite(fontSize) ? fontSize * 1.5 : 0),
    padding: sum(style.paddingTop, style.paddingBottom),
    border: sum(style.borderTopWidth, style.borderBottomWidth),
    maxLines,
  };
}

function sum(...values: string[]): number {
  return values.reduce((total, value) => {
    const parsed = Number.parseFloat(value);
    return total + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
}
