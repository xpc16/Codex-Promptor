import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DICTIONARY_D1, DICTIONARY_DIGEST, dictionaryOffered, digestOf } from "./e2ee-dictionary.js";

/**
 * The bytes both ends compress against. Two things can go wrong with such a
 * thing: the two ends can hold different bytes under the same name, and it
 * can quietly stop being worth having. Both are pinned here.
 */
describe("the preset compression dictionary", () => {
  it("is named by its own bytes", async () => {
    // Change the samples and this fails until the digest is updated -- which
    // is the point. A page built before the change then offers a digest the
    // server does not hold and gets no dictionary, instead of frames that
    // open into noise.
    const expected = `d1:${createHash("sha256").update(DICTIONARY_D1).digest("hex").slice(0, 32)}`;
    expect(DICTIONARY_DIGEST).toBe(expected);
    // And the runtime check both ends make agrees with Node's hash.
    expect(await digestOf(DICTIONARY_D1, globalThis.crypto.subtle)).toBe(expected);
  });

  it("is plain ASCII and well inside deflate's window", () => {
    // ASCII so JSON.stringify and TextEncoder produce the same bytes in every
    // runtime; under 32 KiB because deflate cannot point further back.
    expect(DICTIONARY_D1.every((byte) => byte >= 0x20 && byte < 0x7f)).toBe(true);
    expect(DICTIONARY_D1.length).toBeLessThan(32 * 1024);
    expect(DICTIONARY_D1.length).toBeGreaterThan(1024);
  });

  it("holds no user data, only the protocol's own words", () => {
    const text = Buffer.from(DICTIONARY_D1).toString("utf8");
    // Every id, path and text field is a placeholder.
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(text).not.toMatch(/[A-Z]:\\/);
    expect(text).toContain('"type":"terminal.screen"');
    expect(text).toContain('"clearToEnd":true');
  });

  it("more than halves a projection delta, which is what it is for", () => {
    // The tunnel's main flow: a one-row delta, sealed to 464 B on average over
    // two weeks. Without the dictionary each frame carries a 360-byte header
    // that never changes; with it, that header costs a few back-references.
    const style = { fg: "default", bg: "default", flags: [] };
    const frame = JSON.stringify({
      type: "terminal.screen", tabId: "b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b", generation: "7e8f9a0b-1c2d-4e3f-a4b5-c6d7e8f9a0b1",
      streamId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", sequence: 4821, revision: 91827, full: false,
      cols: 120, totalRows: 6000, viewportTop: 5980, viewportRows: 20, alternateScreen: false, sizeEpoch: 3,
      inputModes: { applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: true, mouseTracking: "none", sendFocus: false },
      cursor: { row: 19, col: 2, visible: true },
      rows: [{ row: 12, clearToEnd: true, runs: [{ text: "  1. Compiling src/server/app.ts (1237 lines)", style }, { text: " done", style: { fg: 2, bg: "default", flags: ["bold"] } }] }],
      scroll: { top: 0, bottom: 19, lines: 1 },
    });
    const raw = Buffer.from(frame);
    const alone = deflateRawSync(raw).length;
    const withDictionary = deflateRawSync(raw, { dictionary: Buffer.from(DICTIONARY_D1) }).length;
    expect(withDictionary).toBeLessThan(alone * 0.5);
    // A regression guard on the absolute number, loose enough for zlib to move.
    expect(withDictionary).toBeLessThan(230);
  });

  it("is offered by digest and nothing else", () => {
    expect(dictionaryOffered(DICTIONARY_DIGEST)).toBe(true);
    expect(dictionaryOffered("d1:0000")).toBe(false);
    expect(dictionaryOffered(undefined)).toBe(false);
  });
});
