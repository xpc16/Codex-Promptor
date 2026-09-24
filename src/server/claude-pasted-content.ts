/** Claude wraps text pasted into its terminal with this transport envelope. */
export function unwrapClaudePastedContent(text: string): string {
  const match = text.trim().match(/^<pasted_content id="([A-Za-z0-9_-]{1,64})">\r?\n([\s\S]*?)\r?\n<\/pasted_content id="\1">$/);
  return match ? match[2] : text;
}
