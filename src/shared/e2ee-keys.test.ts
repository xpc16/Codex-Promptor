import { describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64, keyFingerprint, normalizePassphrase } from "./e2ee-keys.js";

const digest = (first: number, second: number) =>
  new Uint8Array([first, second, ...new Array(30).fill(0).map((_, i) => (i * 7) & 0xff)]);

describe("the name a reader compares", () => {
  it("is eight base32 characters in two groups", () => {
    // Shown on both pages so the reader can glance at them and know they
    // paired. It is the cheapest check there is against a page that was served
    // something other than what this machine holds.
    expect(keyFingerprint(digest(0xff, 0x00))).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });

  it("differs when the key differs", () => {
    expect(keyFingerprint(digest(1, 2))).not.toBe(keyFingerprint(digest(1, 3)));
  });

  it("is stable for the same key", () => {
    expect(keyFingerprint(digest(9, 9))).toBe(keyFingerprint(digest(9, 9)));
  });
});

describe("base64 for the wire", () => {
  it("round-trips every byte value", () => {
    const all = new Uint8Array(256).map((_, i) => i);
    expect([...decodeBase64(encodeBase64(all))]).toEqual([...all]);
  });

  it("round-trips nothing", () => {
    expect(decodeBase64(encodeBase64(new Uint8Array(0))).length).toBe(0);
  });
});

describe("accepting a passphrase", () => {
  it("takes what a person actually types", () => {
    // Typed passphrases are accepted by design; this is not a strength meter.
    expect(normalizePassphrase("我的密码 123")).toBe("我的密码 123");
    expect(normalizePassphrase("  padded  ")).toBe("padded");
  });

  it("refuses what could not survive being typed again", () => {
    expect(normalizePassphrase("")).toBeNull();
    expect(normalizePassphrase("   ")).toBeNull();
  });
});
