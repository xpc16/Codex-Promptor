import { randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  HTTP_COMPRESSION_MIN_BYTES,
  HTTP_NONCE_BYTES,
  decodeHttpHeader,
  encodeHttpHeader,
  httpCiphertext,
} from "../shared/e2ee-http.js";
import { subKey } from "./e2ee-key-material.js";
import { open, seal } from "./e2ee-session.js";

/**
 * Sealing and opening an HTTP body with the key both ends already hold.
 *
 * Compression happens here, before the seal, and that order is the whole
 * traffic story: the tunnel currently compresses 18.83 MB of application bytes
 * down to 8.31 MB, and ciphertext does not compress at all. Encrypting first
 * and letting gzip try afterwards would spend CPU to send more bytes than not
 * encrypting at all.
 */

const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

export function sealHttpBody(master: Buffer, plaintext: string): Buffer {
  const raw = Buffer.from(plaintext, "utf8");
  const candidate = raw.length >= HTTP_COMPRESSION_MIN_BYTES ? deflateRawSync(raw) : null;
  const compressed = candidate !== null && candidate.length < raw.length;
  const nonce = randomBytes(HTTP_NONCE_BYTES);
  const header = encodeHttpHeader({ compressed, nonce: new Uint8Array(nonce) });
  const body = compressed ? candidate! : raw;
  return Buffer.concat([header, seal(subKey(master, "http"), new Uint8Array(nonce), new Uint8Array(body), header)]);
}

/**
 * Null for a body that does not open, which covers a wrong key, a truncated
 * upload and a relay that changed a byte -- all of which are the same answer
 * to the caller: this is not usable, and nothing about it should be acted on.
 */
export function openHttpBody(master: Buffer, body: Uint8Array): string | null {
  const header = decodeHttpHeader(body);
  if (!header) return null;
  const opened = open(subKey(master, "http"), header.nonce, httpCiphertext(body), body.subarray(0, 1 + HTTP_NONCE_BYTES));
  if (!opened) return null;
  if (!header.compressed) return opened.toString("utf8");
  try {
    // Bounded, because the length is claimed by whoever sent it. The tag has
    // already proved they hold the key, so this is not a defence against a
    // stranger -- it is a defence against a bug on either end turning into
    // this process allocating without limit.
    return inflateRawSync(opened, { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
  } catch {
    return null;
  }
}
