import { describe, expect, it, vi } from "vitest";

import type { DocumentOpenMetadata } from "../shared/document-protocol.js";
import { DocumentLoader, type DocumentTransport } from "./document-loader.js";

const metadata = (size: number, kind: "text" | "markdown" = "text"): DocumentOpenMetadata => ({
  docId: "abcdefghijklmnopqrstuv",
  name: kind === "text" ? "notes.txt" : "notes.md",
  kind,
  size,
  revision: "zyxwvutsrqponmlkjihgfe",
  encoding: "utf-8",
});

describe("DocumentLoader", () => {
  it("strictly streams UTF-8 across a fixed chunk boundary", async () => {
    const bytes = new TextEncoder().encode(`${"a".repeat(8191)}中z`);
    const chunks = [bytes.subarray(0, 8192), bytes.subarray(8192)];
    const transport: DocumentTransport = {
      open: async () => metadata(bytes.length),
      chunk: vi.fn(async (_metadata, index) => chunks[index]),
    };
    const loader = new DocumentLoader(transport);

    await loader.open({ tabId: "tab", href: "./notes.txt" });
    await loader.loadNext();
    expect(loader.state.loadedBytes).toBe(8192);
    expect(loader.state.textSegments.join("")).toBe("a".repeat(8191));
    await loader.loadNext();
    expect(loader.state.textSegments.join("")).toBe(`${"a".repeat(8191)}中z`);
    expect(loader.state.complete).toBe(true);
  });

  it("allows only one sequential chunk request in flight", async () => {
    let resolveSecond!: (value: Uint8Array) => void;
    const second = new Promise<Uint8Array>((resolve) => { resolveSecond = resolve; });
    const firstChunk = new Uint8Array(8192).fill(97);
    const chunk = vi.fn(async (_metadata: DocumentOpenMetadata, index: number) => index === 0 ? firstChunk : second);
    const loader = new DocumentLoader({ open: async () => metadata(8193), chunk });
    await loader.open({ tabId: "tab", href: "./notes.txt" });
    await loader.loadNext();

    const first = loader.loadNext();
    const duplicate = loader.loadNext();
    expect(chunk).toHaveBeenCalledTimes(2);
    resolveSecond(new Uint8Array([98]));
    await Promise.all([first, duplicate]);
    expect(loader.state.textSegments.join("")).toBe(`${"a".repeat(8192)}b`);
  });

  it("ignores a late chunk after close", async () => {
    let resolveChunk!: (value: Uint8Array) => void;
    const pending = new Promise<Uint8Array>((resolve) => { resolveChunk = resolve; });
    const loader = new DocumentLoader({ open: async () => metadata(1), chunk: async () => pending });
    await loader.open({ tabId: "tab", href: "./notes.txt" });
    const opening = loader.loadNext();
    loader.close();
    resolveChunk(new Uint8Array([97]));
    await opening;
    expect(loader.state.status).toBe("closed");
    expect(loader.state.textSegments).toEqual([]);
  });

  it("reports invalid UTF-8 without advancing the chunk index", async () => {
    const loader = new DocumentLoader({
      open: async () => metadata(2),
      chunk: async () => new Uint8Array([0xc3, 0x28]),
    });
    await loader.open({ tabId: "tab", href: "./notes.txt" });
    await loader.loadNext();
    expect(loader.state.status).toBe("error");
    expect((loader.state.error as any)?.code).toBe("DOCUMENT_ENCODING_UNSUPPORTED");
    expect(loader.state.nextChunkIndex).toBe(0);
  });

  it("assembles Markdown only after a safe block boundary", async () => {
    const first = new TextEncoder().encode(`# title\n\npart${"x".repeat(8192 - "# title\n\npart".length)}`);
    const second = new TextEncoder().encode(" two");
    const loader = new DocumentLoader({
      open: async () => metadata(first.length + second.length, "markdown"),
      chunk: async (_meta, index) => index === 0 ? first : second,
    });
    await loader.open({ tabId: "tab", href: "./notes.md" });
    await loader.loadNext();
    expect(loader.state.markdownBlocks).toEqual(["# title\n\n"]);
    expect(loader.state.pendingMarkdown.startsWith("part")).toBe(true);
    await loader.loadNext();
    expect(loader.state.markdownBlocks.at(-1)?.endsWith(" two")).toBe(true);
    expect(loader.state.pendingMarkdown).toBe("");
  });
});
