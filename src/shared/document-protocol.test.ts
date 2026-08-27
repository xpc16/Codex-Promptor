import { describe, expect, it } from "vitest";
import { DOCUMENT_CHUNK_BYTES, DOCUMENT_FIRST_CHUNK_BYTES, documentChunkCount, documentChunkRange } from "./document-protocol.js";

describe("document chunk protocol", () => {
  it("uses an 8 KiB first chunk and fixed 16 KiB following chunks", () => {
    const size = DOCUMENT_FIRST_CHUNK_BYTES + DOCUMENT_CHUNK_BYTES + 11;
    expect(documentChunkCount(size)).toBe(3);
    expect(documentChunkRange(size, 0)).toEqual({ start: 0, length: DOCUMENT_FIRST_CHUNK_BYTES, last: false });
    expect(documentChunkRange(size, 1)).toEqual({ start: DOCUMENT_FIRST_CHUNK_BYTES, length: DOCUMENT_CHUNK_BYTES, last: false });
    expect(documentChunkRange(size, 2)).toEqual({ start: DOCUMENT_FIRST_CHUNK_BYTES + DOCUMENT_CHUNK_BYTES, length: 11, last: true });
  });

  it("handles empty and invalid ranges without inventing a request", () => {
    expect(documentChunkCount(0)).toBe(0);
    expect(documentChunkRange(0, 0)).toBeNull();
    expect(documentChunkRange(10, -1)).toBeNull();
    expect(documentChunkRange(10, 1)).toBeNull();
  });
});
