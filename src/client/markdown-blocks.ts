const UNCLOSED_BLOCK_LIMIT = 64 * 1024;

export type MarkdownBlockResult = { blocks: string[]; pending: string };

/**
 * Incrementally commits complete top-level Markdown blocks. The uncommitted
 * tail is rendered as plain text by DocumentView, so a split fence or a very
 * slow chunk can never make already received content disappear.
 */
export class MarkdownBlockAssembler {
  private buffer = "";

  append(text: string, complete = false): MarkdownBlockResult {
    this.buffer += text;
    if (complete) {
      const final = this.buffer;
      this.buffer = "";
      return { blocks: final ? [final] : [], pending: "" };
    }

    const cut = lastSafeBoundary(this.buffer);
    if (cut <= 0) return { blocks: [], pending: this.buffer };
    const committed = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return { blocks: splitCommittedBlocks(committed), pending: this.buffer };
  }

  pending(): string { return this.buffer; }

  reset(): void { this.buffer = ""; }
}

function lastSafeBoundary(source: string): number {
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let offset = 0;
  let safe = 0;
  let currentLooksLikeList = false;
  const lines = source.match(/.*?(?:\r?\n|$)/g) ?? [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const content = line.replace(/\r?\n$/, "");
    const fenceMatch = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(content)) fence = null;
    }
    if (!fence && /^(?: {0,3}(?:[-+*]|\d+[.)])\s+)/.test(content)) currentLooksLikeList = true;
    const end = offset + line.length;
    if (!fence && /^\s*$/.test(content)) {
      const next = nextNonBlank(lines, index + 1);
      const continuesList = currentLooksLikeList && next !== null
        && /^(?:\s{2,}| {0,3}(?:[-+*]|\d+[.)])\s+)/.test(next);
      if (!continuesList) {
        safe = end;
        currentLooksLikeList = false;
      }
    }
    offset = end;
  }
  // Deliberately do not commit an unclosed fence. DocumentView shows pending
  // text verbatim; this guard documents and bounds the amount hidden from the
  // Markdown renderer even for malformed input.
  if (fence && source.length > UNCLOSED_BLOCK_LIMIT) return safe;
  return safe;
}

function nextNonBlank(lines: string[], start: number): string | null {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index].replace(/\r?\n$/, "");
    if (line.trim()) return line;
  }
  return null;
}

function splitCommittedBlocks(source: string): string[] {
  const blocks: string[] = [];
  let cursor = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  const lines = source.match(/.*?(?:\r?\n|$)/g) ?? [];
  let offset = 0;
  let currentLooksLikeList = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const content = line.replace(/\r?\n$/, "");
    const match = content.match(/^ {0,3}(`{3,}|~{3,})/);
    if (match) {
      const marker = match[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: match[1].length };
      else if (marker === fence.marker && match[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(content)) fence = null;
    }
    if (!fence && /^(?: {0,3}(?:[-+*]|\d+[.)])\s+)/.test(content)) currentLooksLikeList = true;
    offset += line.length;
    if (!fence && /^\s*$/.test(content)) {
      const next = nextNonBlank(lines, index + 1);
      if (currentLooksLikeList && next !== null && /^(?:\s{2,}| {0,3}(?:[-+*]|\d+[.)])\s+)/.test(next)) continue;
      const value = source.slice(cursor, offset);
      if (value.trim()) blocks.push(value);
      cursor = offset;
      currentLooksLikeList = false;
    }
  }
  if (cursor < source.length && source.slice(cursor).trim()) blocks.push(source.slice(cursor));
  return blocks;
}
