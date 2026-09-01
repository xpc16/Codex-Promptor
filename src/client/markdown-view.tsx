import React, { lazy, Suspense } from "react";
import type { SafeMarkdownProps } from "./safe-markdown.js";

/**
 * The markdown renderer, off the critical path.
 *
 * react-markdown and the unified stack behind it are 46 KB gzipped -- a fifth
 * of everything the page used to download before it could paint anything. None
 * of it is needed to show the terminal or the queue, and a conversation with no
 * answers yet never needs it at all.
 *
 * Until it arrives the source is shown as text rather than as nothing: an
 * answer that is readable but unformatted beats an empty card, and on a cold
 * load over the tunnel that gap is measured in a round trip, not a repaint.
 */
const SafeMarkdown = lazy(async () => ({ default: (await import("./safe-markdown.js")).SafeMarkdown }));

export function MarkdownView(props: SafeMarkdownProps) {
  return <Suspense fallback={<div className="markdown-pending">{props.source}</div>}>
    <SafeMarkdown {...props} />
  </Suspense>;
}

/**
 * Fetches the renderer once the page is idle.
 *
 * Deferring it is the point; leaving it until the reader scrolls to an answer
 * is not. This asks for it after first paint, so the download overlaps with a
 * page that is already usable instead of holding it up.
 */
export function preloadMarkdownView(): void {
  const load = () => { void import("./safe-markdown.js"); };
  if (typeof window === "undefined") return;
  const idle = (window as any).requestIdleCallback;
  if (typeof idle === "function") idle(load, { timeout: 3_000 });
  else window.setTimeout(load, 1_000);
}
