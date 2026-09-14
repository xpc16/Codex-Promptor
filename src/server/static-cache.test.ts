import { describe, expect, it } from "vitest";
import { IMMUTABLE_CACHE_CONTROL, immutableCacheControl } from "./static-cache.js";

describe("static cache policy", () => {
  it("lets a content-hashed chunk be cached for good", () => {
    expect(immutableCacheControl("/assets/index-DqODgTnP.js", 200)).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(immutableCacheControl("/assets/xterm-DFuMZ0ql.css", 200)).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(immutableCacheControl("/assets/safe-markdown-D6y-9PJX.js", 304)).toBe(IMMUTABLE_CACHE_CONTROL);
    // A query string is not part of the name the hash is in.
    expect(immutableCacheControl("/assets/react-aw5iagu4.js?v=1", 200)).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it("leaves everything whose name can be reused alone", () => {
    // The document that carries the hashes has to be revalidated every time.
    expect(immutableCacheControl("/index.html", 200)).toBeNull();
    expect(immutableCacheControl("/", 200)).toBeNull();
    expect(immutableCacheControl("/favicon.svg", 200)).toBeNull();
    // Unhashed build outputs at the root, and anything outside /assets/.
    expect(immutableCacheControl("/i18n.js", 200)).toBeNull();
    expect(immutableCacheControl("/api/assets/x-abcdefgh.js", 200)).toBeNull();
    // Looks hashed but is not: too short, or no separator.
    expect(immutableCacheControl("/assets/index-abc.js", 200)).toBeNull();
    expect(immutableCacheControl("/assets/vendor.js", 200)).toBeNull();
  });

  it("never pins a miss", () => {
    // A stale name from an old index.html. The next build may create it.
    expect(immutableCacheControl("/assets/index-Old1Old1.js", 404)).toBeNull();
    expect(immutableCacheControl("/assets/index-DqODgTnP.js", 500)).toBeNull();
  });
});
