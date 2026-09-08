import { createDecipheriv, createCipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { GCM_TAG_BYTES } from "../shared/e2ee-envelope.js";
import { CONNECTION_LABELS, decodeBase64, encodeBase64 } from "../shared/e2ee-keys.js";
import {
  CHALLENGE_BYTES,
  CONNECTION_SALT_BYTES,
  HANDSHAKE_CHALLENGE,
  handshakeAad,
  type HandshakeChallenge,
} from "../shared/e2ee-handshake.js";
import { deriveMasterKey, fingerprintOf, subKey } from "./e2ee-key-material.js";

/** AES-256-GCM, both ends, because it is what WebCrypto and Node both have. */
export function seal(key: Buffer, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/** Null rather than throwing: a failed open is an expected outcome here, not an error. */
export function open(key: Buffer, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer | null {
  if (sealed.length < GCM_TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - GCM_TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - GCM_TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

export type ConnectionKeys = { toClient: Buffer; toServer: Buffer };

/**
 * The keys one connection uses, derived from the master and a salt this
 * connection alone will ever see.
 *
 * Per connection and per direction is what lets the nonce be a bare counter:
 * a counter can only repeat under a key that is reused, and no two connections
 * share one. It is also what makes a reconnect free -- new salt, new keys,
 * counters legitimately back to zero.
 */
export function connectionKeys(master: Buffer, connectionSalt: Uint8Array): ConnectionKeys {
  const derive = (label: string) =>
    Buffer.from(hkdfSync("sha256", master, connectionSalt, Buffer.from(label, "utf8"), 32));
  return { toClient: derive(CONNECTION_LABELS.toClient), toServer: derive(CONNECTION_LABELS.toServer) };
}

export type PendingHandshake = {
  message: HandshakeChallenge;
  /** Kept to check the answer, and never sent. */
  expected: Buffer;
  /**
   * Derived here, from the salt this challenge carries, and installed only
   * once the answer checks out. Doing it now keeps the master key out of the
   * connection's closure: what the socket ends up holding is two keys good for
   * this connection alone.
   */
  keys: ConnectionKeys;
};

/**
 * The challenge a connection is greeted with, and the answer that will satisfy
 * it.
 *
 * The nonce is all zeros for both proofs, which is safe only because the auth
 * key is derived fresh from a random per-connection salt: this key encrypts
 * exactly two messages in its life, one in each direction, told apart by the
 * role in their AAD.
 */
export function startHandshake(master: Buffer, fingerprint: string): PendingHandshake {
  const connectionSalt = randomBytes(CONNECTION_SALT_BYTES);
  const challenge = randomBytes(CHALLENGE_BYTES);
  const auth = subKey(master, "auth");
  const nonce = new Uint8Array(12);
  return {
    message: {
      type: HANDSHAKE_CHALLENGE,
      connectionSalt: encodeBase64(new Uint8Array(connectionSalt)),
      challenge: encodeBase64(new Uint8Array(challenge)),
      serverProof: encodeBase64(new Uint8Array(seal(auth, nonce, challenge, handshakeAad("server", fingerprint)))),
      fingerprint,
    },
    expected: seal(auth, nonce, challenge, handshakeAad("client", fingerprint)),
    keys: connectionKeys(master, new Uint8Array(connectionSalt)),
  };
}

/**
 * Compared in constant time. The comparison leaks nothing useful either way --
 * the answer is derived, not guessed -- but a timing-safe compare on a
 * cryptographic value costs nothing and stops this being the exception someone
 * has to think about later.
 */
export function handshakeAnswered(pending: PendingHandshake, proof: unknown): boolean {
  if (typeof proof !== "string" || proof.length === 0) return false;
  let received: Uint8Array;
  try { received = decodeBase64(proof); } catch { return false; }
  if (received.length !== pending.expected.length) return false;
  return timingSafeEqual(Buffer.from(received), pending.expected);
}

/** Derives the master key the encryption tab describes, or null when no tab describes one. */
export async function masterKeyFor(
  session: { provider: string; workingDirectory: string | null; e2ee: { salt: string; iterations: number; fingerprint: string } | null },
): Promise<{ master: Buffer; fingerprint: string } | null> {
  if (session.provider !== "e2ee" || !session.workingDirectory || !session.e2ee) return null;
  const master = await deriveMasterKey(session.workingDirectory, Buffer.from(decodeBase64(session.e2ee.salt)), session.e2ee.iterations);
  return { master, fingerprint: fingerprintOf(master) };
}
