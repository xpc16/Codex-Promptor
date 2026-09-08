/**
 * Deriving the keys both ends use, from a passphrase the user carries there
 * themselves.
 *
 * PBKDF2 rather than Argon2id, and the reason is the browser: WebCrypto's
 * `deriveBits` offers PBKDF2, HKDF and ECDH and nothing else, so a
 * memory-hard KDF would mean shipping WASM to every page. Node 24 has
 * `crypto.argon2`, but only one of the two ends having it is the same as
 * neither. PBKDF2 gives up memory hardness -- an attacker with GPUs gets more
 * per unit of our time than they would against Argon2id -- and buys zero
 * dependencies and zero bundle on a path that had just been trimmed.
 *
 * That trade is proportionate to what this layer defends against: a tunnel
 * operator logging traffic in bulk, not somebody spending compute on one
 * person's terminal. See docs/E2EE_MINIMAL_DESIGN.md §3.1.
 */

/** OWASP's floor for PBKDF2-HMAC-SHA256. Paid once, at pairing, on both ends. */
export const PBKDF2_ITERATIONS = 600_000;

export const SALT_BYTES = 16;
export const MASTER_KEY_BYTES = 32;

/**
 * The uses a master key is split into directly, so that ciphertext from one can
 * never be replayed as another. HKDF costs nothing and the alternative -- one
 * key everywhere -- is the mistake that makes those replays possible. The two
 * WebSocket directions are below, because they take a further step.
 */
export const KEY_LABELS = {
  http: "promptor/http/v1",
  auth: "promptor/auth/v1",
} as const;

export type KeyPurpose = keyof typeof KEY_LABELS;

/**
 * The two WebSocket keys, which are derived one step further down than the
 * others: from the master *and* a salt the connection alone will ever see.
 *
 * That extra step is what lets a frame carry no nonce. A bare counter can only
 * repeat under a key that is reused, and no two connections share one of
 * these, so counters legitimately start at zero on every reconnect.
 */
export const CONNECTION_LABELS = {
  toClient: "promptor/ws/s2c/v1",
  toServer: "promptor/ws/c2s/v1",
} as const;

export type ConnectionDirection = keyof typeof CONNECTION_LABELS;

/**
 * A short, human-comparable name for a key.
 *
 * Shown on the local page and on the remote one: the reader glances at both
 * and knows they paired. It is the cheapest check available against a page
 * that was served something other than what this machine holds, which is the
 * one hole end-to-end encryption in a browser cannot close by itself.
 */
export function keyFingerprint(digest: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < digest.length && out.length < 8; i += 1) {
    value = (value << 8) | digest[i]!;
    bits += 8;
    while (bits >= 5 && out.length < 8) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * A passphrase for the reader who would rather not think of one.
 *
 * Grouped base32 because it gets typed again on another device, by hand, from
 * a phone screen: no case to get wrong, and none of the characters that are
 * read as each other. 20 characters of this alphabet is 100 bits, which is
 * past the point where the KDF is what matters.
 */
export function randomPassphrase(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);
  return [0, 5, 10, 15].map((start) => chars.slice(start, start + 5).join("")).join("-");
}

/**
 * Whether a passphrase is usable at all.
 *
 * Deliberately not a strength meter. A typed passphrase is accepted by design
 * (§3.1); this only rejects what cannot work -- nothing, or whitespace that
 * would be lost the moment it is typed again on the other device.
 */
export function normalizePassphrase(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
