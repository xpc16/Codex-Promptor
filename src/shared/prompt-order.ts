export function reorderPromptIds(ids: readonly string[], sourceId: string, targetId: string): string[] | null {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return null;
  const reordered = [...ids];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return reordered;
}
