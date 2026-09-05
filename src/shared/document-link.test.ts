import { describe, expect, it } from "vitest";
import { extractDocumentTarget, isLoopbackHostname, normalizeDocumentHrefForMarkdown, splitLineAnchor } from "./document-link.js";

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

describe("a link that cites a line", () => {
  it("reads the trailing line, and the column when one is given", () => {
    // How agents cite sources; Markdown offers no other way to say it.
    expect(splitLineAnchor("D:/docs/notes.md:140")).toEqual({ path: "D:/docs/notes.md", line: 140 });
    expect(splitLineAnchor("D:/docs/notes.md:140:12")).toEqual({ path: "D:/docs/notes.md", line: 140 });
  });

  it("leaves a path that cites nothing alone", () => {
    expect(splitLineAnchor("D:/docs/notes.md")).toEqual({ path: "D:/docs/notes.md", line: null });
    expect(splitLineAnchor("D:/docs/notes.md")).toEqual({ path: "D:/docs/notes.md", line: null });
  });

  it("keeps the drive letter it would otherwise eat", () => {
    expect(splitLineAnchor("C:/x")).toEqual({ path: "C:/x", line: null });
  });

  it("still refuses a stream name that is not a line number", () => {
    // Only a numeric suffix is a citation. Anything else stays in the path and
    // is refused downstream as an alternate data stream.
    expect(splitLineAnchor("D:/docs/notes.md:secret")).toEqual({ path: "D:/docs/notes.md:secret", line: null });
    expect(splitLineAnchor("D:/docs/notes.md:14a")).toEqual({ path: "D:/docs/notes.md:14a", line: null });
  });

  it("takes the anchor off the target a click resolves", () => {
    expect(extractDocumentTarget("D:/docs/notes.md:140").path).toBe("D:/docs/notes.md");
    expect(extractDocumentTarget("/D:/docs/notes.md:140").path).toBe("D:/docs/notes.md");
    expect(extractDocumentTarget("./notes.md:140").path).toBe("./notes.md");
    expect(extractDocumentTarget("file:///D:/docs/notes.md:140").path).toBe("D:/docs/notes.md");
  });
});

describe("a link written the way an answer describes a workspace", () => {
  it("treats a bare relative path as a file, not as a URL", () => {
    // The reported case: clicking one navigated the page and the reader lost
    // the conversation, because nothing recognised it as a path.
    expect(extractDocumentTarget("iter_desk_model/output_v2/renders/ITER_closed_final.png"))
      .toMatchObject({ kind: "local-file", path: "iter_desk_model/output_v2/renders/ITER_closed_final.png" });
    expect(extractDocumentTarget("README.md")).toMatchObject({ kind: "local-file", path: "README.md" });
    expect(extractDocumentTarget(String.raw`docs\notes.md`)).toMatchObject({ kind: "local-file", path: String.raw`docs\notes.md` });
  });

  it("still refuses a site-absolute path", () => {
    // `/api/...` is the app's own surface, never a file beside the project.
    expect(extractDocumentTarget("/api/tabs").kind).toBe("unknown");
    expect(extractDocumentTarget(String.raw`\api\tabs`).kind).toBe("unknown");
  });

  it("leaves protocols alone", () => {
    expect(extractDocumentTarget("https://example.com/a.png").kind).toBe("external");
    expect(extractDocumentTarget("mailto:someone@example.com").kind).toBe("external");
    expect(extractDocumentTarget("javascript:alert(1)").kind).toBe("blocked");
    expect(extractDocumentTarget("weird+scheme:payload").kind).toBe("unknown");
  });

  it("keeps the fragment and the cited line off the path", () => {
    expect(extractDocumentTarget("docs/notes.md#install")).toMatchObject({ path: "docs/notes.md", fragment: "install" });
    expect(extractDocumentTarget("docs/notes.md:140")).toMatchObject({ kind: "local-file", path: "docs/notes.md" });
  });
});
