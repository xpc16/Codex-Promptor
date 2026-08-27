import { describe, expect, it } from "vitest";
import { extractDocumentTarget, isLoopbackHostname, normalizeDocumentHrefForMarkdown } from "./document-link.js";

describe("document link classification", () => {
  it.each(["localhost", "127.0.0.1", "::1", "[::1]"])("recognizes loopback hostname %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each(["promptor.example.com", "127.0.0.2", "localhost.example.com"])("rejects non-loopback hostname %s", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });

  it("recognizes file URIs, drive paths, internal paths and relative paths", () => {
    expect(extractDocumentTarget("file:///D:/work/a%20b.md")).toMatchObject({ kind: "local-file", path: "D:/work/a b.md", displayName: "a b.md" });
    expect(extractDocumentTarget("D:\\work\\a.md")).toMatchObject({ kind: "local-file", path: "D:\\work\\a.md" });
    expect(extractDocumentTarget("/D:/work/a.md")).toMatchObject({ kind: "local-file", path: "D:/work/a.md" });
    expect(extractDocumentTarget("../notes/a.txt#part")).toMatchObject({ kind: "local-file", path: "../notes/a.txt", fragment: "part" });
  });

  it("keeps web and fragment links out of the document path", () => {
    expect(extractDocumentTarget("https://example.com/a.md").kind).toBe("external");
    expect(extractDocumentTarget("#part")).toMatchObject({ kind: "fragment", fragment: "part" });
    expect(extractDocumentTarget("/api/tabs").kind).toBe("unknown");
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)", "file:///D:/a.md?download=1"])("blocks dangerous or ambiguous URL %s", (href) => {
    expect(extractDocumentTarget(href).kind).toBe("blocked");
  });

  it("normalizes only absolute Windows document links for markdown sanitation", () => {
    expect(normalizeDocumentHrefForMarkdown("D:\\work\\a b.md")).toBe("file:///D:/work/a%20b.md");
    expect(normalizeDocumentHrefForMarkdown("./a.md")).toBe("./a.md");
    expect(normalizeDocumentHrefForMarkdown("javascript:alert(1)")).toBe("javascript:alert(1)");
  });
});
