import React, { type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { extractDocumentTarget, normalizeDocumentHrefForMarkdown } from "../shared/document-link.js";
import { slugHeading } from "./markdown-headings.js";

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
      if (target.kind === "external" || target.kind === "fragment") return <a {...props} href={href}>{children}</a>;
      // Whatever is left is not something to follow, and following it would
      // unload the app. An answer must never be able to take the reader out of
      // the conversation they are reading.
      return <a {...props} href={href} onClick={(event) => event.preventDefault()}>{children}</a>;
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
