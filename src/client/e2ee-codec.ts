import { MAX_INFLATED_BYTES } from "../shared/e2ee-envelope.js";

/**
 * Deflate and inflate for the browser, with a preset dictionary.
 *
 * The streaming APIs the platform ships -- `CompressionStream` and
 * `DecompressionStream` -- take no dictionary, and the dictionary is worth
 * more than half of every projection frame (e2ee-dictionary.ts). So the
 * codec is fflate, loaded as its own chunk the first time a sealed
 * connection is about to be negotiated, and only then: the local page never
 * pays for it.
 *
 * If it cannot be loaded, the page simply does not offer a dictionary and the
 * platform streams carry on as before. Nothing here is on the path a page
 * needs to work; it is on the path that makes it cheaper.
 */

export type Codec = {
  deflate(raw: Uint8Array, dictionary: Uint8Array | null): Uint8Array;
  /** Null when the data does not inflate, or would inflate past MAX_INFLATED_BYTES. */
  inflate(data: Uint8Array, dictionary: Uint8Array | null): Uint8Array | null;
};

let loading: Promise<Codec | null> | null = null;

/** The codec, once; null if the chunk could not be fetched or evaluated. */
export function loadCodec(): Promise<Codec | null> {
  loading ??= import("fflate").then((fflate): Codec => ({
    deflate: (raw, dictionary) => fflate.deflateSync(raw, { level: 6, ...(dictionary ? { dictionary } : {}) }),
    inflate: (data, dictionary) => {
      // Streamed so the bound is enforced as bytes arrive, not after they have
      // been allocated. The inflated length is claimed by the sender; the tag
      // has already proved they hold the key, so this is against a bug, not
      // a stranger -- but a browser tab has less room for either.
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        const inflater = new fflate.Inflate(dictionary ? { dictionary } : {}, (chunk) => {
          total += chunk.length;
          if (total > MAX_INFLATED_BYTES) throw new Error("E2EE_INFLATED_TOO_LARGE");
          parts.push(chunk);
        });
        inflater.push(data, true);
      } catch {
        return null;
      }
      if (parts.length === 1) return parts[0]!;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) { out.set(part, offset); offset += part.length; }
      return out;
    },
  })).catch(() => null);
  return loading;
}

/**
 * The codec if it arrives in time, else null -- a handshake must not wait on
 * a chunk that is slow to fetch. The load itself carries on and is there for
 * the next connection.
 */
export function codecWithin(ms: number): Promise<Codec | null> {
  return Promise.race([
    loadCodec(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}
