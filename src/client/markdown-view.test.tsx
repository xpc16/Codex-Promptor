import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownView } from "./markdown-view.js";

describe("MarkdownView", () => {
  it("shows the answer as text while its renderer is still on the way", () => {
    // The renderer is 46 KB gzipped and no longer blocks first paint, so there
    // is a window where an answer exists and the parser does not. Showing the
    // source beats showing an empty card: it is the same words, unformatted.
    const html = renderToStaticMarkup(<MarkdownView source={"# Title\n\nbody text"} />);
    expect(html).toContain("markdown-pending");
    expect(html).toContain("body text");
  });

  it("does not drag the renderer in through the heading helpers", async () => {
    // Planning a document's heading ids used to import the module that owns
    // ReactMarkdown, which put the whole unified stack back on the critical
    // path however carefully the render site was split.
    const headings = await import("./markdown-headings.js");
    expect(headings.planMarkdownHeadingIds(["# One", "# Two"])).toEqual([["one"], ["two"]]);
    const source = await import("node:fs").then((fs) => fs.readFileSync("src/client/markdown-headings.ts", "utf8"));
    expect(source).not.toMatch(/from "react-markdown"|remark-gfm|rehype-sanitize|safe-markdown/);
  });
});
