/**
 * How an HTTP body is carried once it must not be readable by the relay.
 *
 *   [ 1 B flags ][ 12 B nonce ][ ciphertext ][ 16 B GCM tag ]
 *
 * The nonce is here, unlike on the WebSocket, and the difference is the reason
 * the WebSocket can leave it out: there the two ends share an ordered
 * connection and can both count, so a counter alone is unique under a key
 * derived for that connection. HTTP has no such thread -- requests arrive in
 * any order, from any tab of any page, after any reconnect -- and a counter
 * that either side guessed wrong would repeat a nonce, which is the one thing
 * AES-GCM cannot survive. Twelve random bytes on a body averaging 7.7 kB is
 * nothing; a repeated nonce would be everything.
 *
 * There is no handshake for HTTP either, and none is needed. Holding the key
 * *is* the authorization: a request that cannot be opened is refused, and a
 * response nobody can open tells the relay nothing. What the handshake buys on
 * the WebSocket -- a clear, immediate failure rather than a broken-looking
 * page -- is already bought there, before any of this is reached.
 */

export const E2EE_BODY_HEADER = "x-promptor-e2ee";
export const E2EE_BODY_CONTENT_TYPE = "application/octet-stream";

export const HTTP_NONCE_BYTES = 12;
export const HTTP_HEADER_BYTES = 1 + HTTP_NONCE_BYTES;
export const HTTP_TAG_BYTES = 16;

export const HTTP_FLAG_COMPRESSED = 0x01;

/**
 * Compressed before sealing, never after: ciphertext does not compress, so a
 * gzip applied downstream would spend CPU to add bytes. Encrypted responses
 * therefore carry `content-encoding: identity` and do this themselves.
 */
export const HTTP_COMPRESSION_MIN_BYTES = 512;

export type HttpBodyHeader = { compressed: boolean; nonce: Uint8Array };

export function encodeHttpHeader(header: HttpBodyHeader): Uint8Array {
  if (header.nonce.length !== HTTP_NONCE_BYTES) throw new Error("E2EE_HTTP_NONCE_SIZE");
  const out = new Uint8Array(HTTP_HEADER_BYTES);
  out[0] = header.compressed ? HTTP_FLAG_COMPRESSED : 0;
  out.set(header.nonce, 1);
  return out;
}

/** Null for anything too short to be a body, or carrying a flag this version does not define. */
export function decodeHttpHeader(body: Uint8Array): HttpBodyHeader | null {
  if (body.length < HTTP_HEADER_BYTES + HTTP_TAG_BYTES) return null;
  const flags = body[0]!;
  if ((flags & ~HTTP_FLAG_COMPRESSED) !== 0) return null;
  return { compressed: (flags & HTTP_FLAG_COMPRESSED) !== 0, nonce: body.subarray(1, HTTP_HEADER_BYTES) };
}

export function httpCiphertext(body: Uint8Array): Uint8Array {
  return body.subarray(HTTP_HEADER_BYTES);
}

/**
 * Whether a route's body is worth encrypting.
 *
 * The API is; the built page is not. `index.html`, the JavaScript and the CSS
 * are the same bytes for everyone and are already public -- encrypting them
 * would defeat the browser cache that makes the page load at all, and hide
 * nothing, since anyone can fetch them from a machine that has no key.
 */
export function bodyNeedsEncryption(url: string): boolean {
  return url.startsWith("/api/");
}

/**
 * The one route that must stay readable: it is what tells a page a key is
 * needed at all, and a page cannot be asked for a key using a message it
 * cannot read.
 */
export function bodyMustStayReadable(url: string): boolean {
  return url.startsWith("/api/bootstrap");
}
