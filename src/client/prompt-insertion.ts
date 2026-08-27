export type DraftSelection = { start: number; end: number; version: number };

export function insertCommonPrompt(
  draft: string,
  text: string,
  captured: DraftSelection | null,
  currentVersion: number,
): { value: string; cursor: number } {
  if (captured && captured.version === currentVersion
    && captured.start >= 0
    && captured.end >= captured.start
    && captured.end <= draft.length) {
    const value = draft.slice(0, captured.start) + text + draft.slice(captured.end);
    return { value, cursor: captured.start + text.length };
  }
  const separator = draft.length === 0 || draft.endsWith("\n") ? "" : "\n\n";
  const value = draft + separator + text;
  return { value, cursor: value.length };
}
