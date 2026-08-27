import { describe, expect, it } from "vitest";
import { entityTag, ifNoneMatchSatisfied } from "./http-cache.js";

describe("entity tags", () => {
  it("is stable for the same body and different for a changed one", () => {
    expect(entityTag("{\"data\":1}")).toBe(entityTag("{\"data\":1}"));
    expect(entityTag("{\"data\":1}")).not.toBe(entityTag("{\"data\":2}"));
  });

  it("is quoted so it is a legal header value", () => {
    expect(entityTag("body")).toMatch(/^"[A-Za-z0-9_-]+"$/);
  });
});

describe("if-none-match", () => {
  const tag = entityTag("body");

  it("misses when the client sent nothing", () => {
    expect(ifNoneMatchSatisfied(undefined, tag)).toBe(false);
    expect(ifNoneMatchSatisfied("", tag)).toBe(false);
  });

  it("matches an exact, a weak and a listed tag", () => {
    expect(ifNoneMatchSatisfied(tag, tag)).toBe(true);
    expect(ifNoneMatchSatisfied(`W/${tag}`, tag)).toBe(true);
    expect(ifNoneMatchSatisfied(`"other", ${tag}`, tag)).toBe(true);
  });

  it("matches a tag a proxy has tagged with its content coding", () => {
    expect(ifNoneMatchSatisfied(`${tag.slice(0, -1)}-gzip"`, tag)).toBe(true);
  });

  it("matches the wildcard and misses an unrelated tag", () => {
    expect(ifNoneMatchSatisfied("*", tag)).toBe(true);
    expect(ifNoneMatchSatisfied("\"stale\"", tag)).toBe(false);
  });
});
