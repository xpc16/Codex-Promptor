import { createHash, hkdfSync, pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
  KEY_LABELS,
  MASTER_KEY_BYTES,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  encodeBase64,
  keyFingerprint,
  type KeyPurpose,
} from "../shared/e2ee-keys.js";

const pbkdf2Async = promisify(pbkdf2);

export type KeyMaterial = {
  /** Base64. Not secret, and the far end cannot derive anything without it. */
  salt: string;
  iterations: number;
  fingerprint: string;
};

/**
 * Turning what the reader typed into the key both ends will hold.
 *
 * Asynchronous on purpose: 600,000 PBKDF2 rounds is a few hundred milliseconds
 * and the synchronous form would spend all of it on the event loop, stalling
 * every terminal stream this process is carrying. The threadpool costs nothing
 * here because this runs once, at pairing.
 */
export async function deriveMasterKey(passphrase: string, salt: Buffer, iterations: number): Promise<Buffer> {
  return pbkdf2Async(passphrase.normalize("NFC"), salt, iterations, MASTER_KEY_BYTES, "sha256");
}

/**
 * Normalized before hashing, because the two ends type it on different
 * keyboards and operating systems. Without NFC the same characters entered on
 * macOS and on Windows can be different bytes, and the failure -- a key that
 * derives differently from the passphrase the reader believes they used --
 * would look like anything except what it is.
 */
export async function newKeyMaterial(passphrase: string): Promise<{ material: KeyMaterial; master: Buffer }> {
  const salt = randomBytes(SALT_BYTES);
  const master = await deriveMasterKey(passphrase, salt, PBKDF2_ITERATIONS);
  return {
    material: {
      salt: encodeBase64(new Uint8Array(salt)),
      iterations: PBKDF2_ITERATIONS,
      fingerprint: fingerprintOf(master),
    },
    master,
  };
}

export function fingerprintOf(master: Buffer): string {
  return keyFingerprint(new Uint8Array(createHash("sha256").update(master).digest()));
}

/**
 * One key per use, so that a message encrypted for one can never be replayed
 * as another. HKDF is in the standard library on both ends; the alternative --
 * the master key everywhere -- is what makes those replays possible.
 */
export function subKey(master: Buffer, purpose: KeyPurpose): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), Buffer.from(KEY_LABELS[purpose], "utf8"), 32));
}
