import React, { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { extractDocumentTarget, normalizeDocumentHrefForMarkdown } from "../shared/document-link.js";

export type SafeMarkdownProps = {
  source: string;
  onDocumentLink?: (href: string) => void;
  headingIds?: readonly string[];
};

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: defaultSchema.tagNames?.filter((tag) => tag !== "img"),
  protocols: {
    ...defaultSchema.protocols,
    href: [...new Set([...(defaultSchema.protocols?.href ?? []), "file"])],
  },
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), "data-document-href", "dataDocumentHref"],
  },
};

export function SafeMarkdown({ source, onDocumentLink, headingIds }: SafeMarkdownProps) {
  const counts = new Map<string, number>();
  let headingIndex = 0;
  const nextHeadingId = (children: ReactNode) => {
    const planned = headingIds?.[headingIndex++];
    if (planned) return planned;
    const base = slugHeading(children);
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
  const components: Components = {
    a: ({ href = "", children, node: _node, ...props }) => {
      const originalHref = typeof (props as any)["data-document-href"] === "string"
        ? (props as any)["data-document-href"]
        : typeof (props as any).dataDocumentHref === "string" ? (props as any).dataDocumentHref : href;
      const target = extractDocumentTarget(originalHref);
      if (target.kind === "blocked") return <span className="blocked-link">{children}</span>;
      if (target.kind === "local-file") return <a {...props} href={href} className="document-link" onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDocumentLink?.(originalHref);
      }}>{children}</a>;
      if (target.kind === "external" && /^https?:/i.test(href)) return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
      return <a {...props} href={href}>{children}</a>;
    },
    h1: heading("h1", nextHeadingId),
    h2: heading("h2", nextHeadingId),
    h3: heading("h3", nextHeadingId),
    h4: heading("h4", nextHeadingId),
    h5: heading("h5", nextHeadingId),
    h6: heading("h6", nextHeadingId),
  };
  return <ReactMarkdown
    skipHtml
    remarkPlugins={[remarkGfm, remarkNormalizeDocumentLinks]}
    rehypePlugins={[[rehypeSanitize, sanitizeSchema]]}
    urlTransform={(value, key, node) => key === "href" && node.tagName === "a" && extractDocumentTarget(value).kind === "local-file"
      ? value
      : defaultUrlTransform(value)}
    components={components}
  >{source}</ReactMarkdown>;
}

/** A dependency-free unified plugin; only mdast link nodes are rewritten. */
export function remarkNormalizeDocumentLinks() {
  return (tree: unknown) => walk(tree);
}

function walk(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const node = value as { type?: unknown; url?: unknown; children?: unknown; data?: Record<string, any> };
  if (node.type === "link" && typeof node.url === "string") {
    const originalHref = node.url;
    const target = extractDocumentTarget(originalHref);
    if (target.kind === "local-file" || target.kind === "blocked") {
      node.data = node.data ?? {};
      node.data.hProperties = { ...(node.data.hProperties ?? {}), "data-document-href": originalHref };
    }
    node.url = normalizeDocumentHrefForMarkdown(originalHref);
  }
  if (Array.isArray(node.children)) for (const child of node.children) walk(child);
}

function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6", id: (children: ReactNode) => string) {
  return ({ children, node: _node, ...props }: any) => <Tag {...props} id={id(children)}>{children}</Tag>;
}

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
