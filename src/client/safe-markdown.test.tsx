import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { planMarkdownHeadingIds, SafeMarkdown, slugHeading } from "./safe-markdown.js";

describe("SafeMarkdown", () => {
  it("keeps document anchors while stripping scripts and images", () => {
    const html = renderToStaticMarkup(<SafeMarkdown source={'[doc](D:/work/a.md) [bad](javascript:alert(1)) ![track](https://example.com/x.png)'} />);
    expect(html).toContain('href="file:///D:/work/a.md"');
    expect(html).toContain('data-document-href="D:/work/a.md"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<img");
    expect(html).toContain('class="blocked-link"');
  });

  it("opens external web links safely", () => {
    const html = renderToStaticMarkup(<SafeMarkdown source="[site](https://example.com)" />);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("generates stable unicode heading slugs", () => {
    expect(slugHeading("Hello, 世界_2026")).toBe("hello-世界-2026");
  });

  it("precomputes duplicate heading suffixes across incremental blocks", () => {
    expect(planMarkdownHeadingIds(["# Same\n", "text\n\n## Same\n"])).toEqual([["same"], ["same-2"]]);
    const html = renderToStaticMarkup(<SafeMarkdown source={"# Same\n\n## Same"} />);
    expect(html).toContain('id="same"');
    expect(html).toContain('id="same-2"');
  });
});
