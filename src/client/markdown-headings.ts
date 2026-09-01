import { Children, isValidElement, type ReactNode } from "react";

/**
 * Heading slugs, without the markdown renderer behind them.
 *
 * These are pure text work, and they used to live beside ReactMarkdown -- so
 * importing them to plan a document's heading ids pulled the whole unified
 * stack (46 KB gzipped) into the same chunk. Kept apart, a caller that only
 * needs ids never loads a parser.
 */

export function slugHeading(children: ReactNode): string {
  return textContent(children)
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
}

function textContent(value: ReactNode): string {
  let result = "";
  Children.forEach(value, (child) => {
    if (typeof child === "string" || typeof child === "number") result += String(child);
    else if (isValidElement<{ children?: ReactNode }>(child)) result += textContent(child.props.children);
  });
  return result;
}

/** Precomputes duplicate-safe heading ids across separately rendered blocks. */
export function planMarkdownHeadingIds(blocks: readonly string[]): string[][] {
  const counts = new Map<string, number>();
  return blocks.map((block) => markdownHeadings(block).map((headingText) => {
    const base = slugHeading(headingText);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  }));
}

function markdownHeadings(source: string): string[] {
  const headings: string[] = [];
  const lines = source.split(/\r?\n/);
  let fence: { marker: "`" | "~"; length: number } | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (!fence) fence = { marker, length: fenceMatch[1].length };
      else if (marker === fence.marker && fenceMatch[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence) continue;
    const atx = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (atx) { headings.push(plainHeadingText(atx[1])); continue; }
    if (index + 1 < lines.length && line.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1])) {
      headings.push(plainHeadingText(line));
      index += 1;
    }
  }
  return headings;
}

function plainHeadingText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/<[^>]*>/g, "")
    .trim();
}
