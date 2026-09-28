import { describe, expect, it } from "vitest";
import { createTerminalCache } from "./terminal-cache.js";
import type { ProjectionScreenState } from "./terminal-projection.js";

const bytes = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0)));
const text = (data: Uint8Array) => String.fromCharCode(...data);

describe("raw terminal memory", () => {
  it("holds nothing for a terminal it has not seen", () => {
    expect(createTerminalCache().readRaw("tab")).toBeNull();
  });

  it("accumulates output and reports where the server should resume", () => {
    const cache = createTerminalCache();
    cache.rememberRaw("tab", "g1", 5, bytes("hello"), true);
    cache.rememberRaw("tab", "g1", 11, bytes(" world"), false);
    expect(cache.readRaw("tab")).toMatchObject({ generation: "g1", nextOffset: 11 });
    expect(text(cache.readRaw("tab")!.data)).toBe("hello world");
  });

  it("starts over on a reset or a new generation", () => {
    const cache = createTerminalCache();
    cache.rememberRaw("tab", "g1", 5, bytes("stale"), false);
    cache.rememberRaw("tab", "g1", 8, bytes("new"), true);
    expect(text(cache.readRaw("tab")!.data)).toBe("new");
    cache.rememberRaw("tab", "g2", 6, bytes("fresh!"), false);
    expect(cache.readRaw("tab")).toMatchObject({ generation: "g2", nextOffset: 6 });
    expect(text(cache.readRaw("tab")!.data)).toBe("fresh!");
  });

  it("drops the oldest whole chunks once it is over its byte budget", () => {
    const cache = createTerminalCache(4, 8);
    cache.rememberRaw("tab", "g1", 4, bytes("aaaa"), true);
    cache.rememberRaw("tab", "g1", 8, bytes("bbbb"), false);
    cache.rememberRaw("tab", "g1", 12, bytes("cccc"), false);
    const raw = cache.readRaw("tab")!;
    expect(text(raw.data)).toBe("bbbbcccc");
    // The cursor still points at the true end of the stream, so the server
    // resumes from there rather than resending what was trimmed.
    expect(raw.nextOffset).toBe(12);
  });

  it("records an offset advance that carried no new bytes", () => {
    const cache = createTerminalCache();
    cache.rememberRaw("tab", "g1", 3, bytes("abc"), true);
    cache.rememberRaw("tab", "g1", 9, new Uint8Array(), false);
    expect(cache.readRaw("tab")).toMatchObject({ nextOffset: 9 });
  });

  it("keeps a rendered checkpoint for instant restoration and invalidates it on a new PTY", () => {
    const cache = createTerminalCache();
    cache.rememberRaw("tab", "g1", 5, bytes("hello"), true);
    cache.rememberRendered("tab", { generation: "g1", nextOffset: 5, cols: 80, rows: 20, ansi: "hello" });
    cache.rememberRaw("tab", "g1", 10, bytes("world"), false);
    expect(cache.readRendered("tab")).toMatchObject({ generation: "g1", nextOffset: 5, ansi: "hello" });
    cache.rememberRendered("tab", { generation: "g1", nextOffset: 10, cols: 80, rows: 20, ansi: "hello world" });
    cache.rememberRendered("tab", { generation: "g1", nextOffset: 5, cols: 80, rows: 20, ansi: "stale" });
    expect(cache.readRendered("tab")?.ansi).toBe("hello world");
    cache.rememberRaw("tab", "g2", 4, bytes("new!"), true);
    expect(cache.readRendered("tab")).toBeNull();
  });
});

describe("projection memory", () => {
  const state = { streamId: "s", generation: "g", revision: 4 } as ProjectionScreenState;

  it("returns the last screen it was given", () => {
    const cache = createTerminalCache();
    cache.rememberProjection("tab", state);
    expect(cache.readProjection("tab")).toBe(state);
    expect(cache.readProjection("other")).toBeNull();
  });
});

describe("eviction", () => {
  it("keeps only the most recently used terminals", () => {
    const cache = createTerminalCache(2);
    cache.rememberRaw("a", "g", 1, bytes("a"), true);
    cache.rememberRaw("b", "g", 1, bytes("b"), true);
    cache.rememberRaw("a", "g", 2, bytes("a"), false);
    cache.rememberRaw("c", "g", 1, bytes("c"), true);
    expect(cache.size()).toBe(2);
    expect(cache.readRaw("a")).not.toBeNull();
    expect(cache.readRaw("b")).toBeNull();
  });

  it("forgets terminals whose conversation is gone", () => {
    const cache = createTerminalCache();
    cache.rememberRaw("a", "g", 1, bytes("a"), true);
    cache.rememberRaw("b", "g", 1, bytes("b"), true);
    cache.retain(new Set(["a"]));
    expect(cache.readRaw("a")).not.toBeNull();
    expect(cache.readRaw("b")).toBeNull();
    cache.forget("a");
    expect(cache.size()).toBe(0);
  });
});
