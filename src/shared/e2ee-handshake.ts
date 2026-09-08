/**
 * The one round trip that happens before anything else crosses an encrypted
 * connection.
 *
 * AEAD already authenticates every frame, so strictly speaking this buys no
 * security: a wrong key fails at the first tag either way. What it buys is
 * *when* and *how* it fails. Without it the reader with a mistyped passphrase
 * gets a terminal that never fills in, or a stream of frames that quietly go
 * nowhere. With it they get told, before a single byte of their conversation
 * is sent anywhere.
 *
 *   server → client   connectionSalt, challenge, serverProof
 *   client            derives, opens serverProof -- proves the server holds it
 *   client → server   clientProof
 *   server            opens clientProof -- proves the client holds it
 *
 * Both directions, because a client that cannot check the far end would accept
 * a hostile relay's noise as a server having trouble. The challenge itself
 * travels in the clear: it is random and means nothing, and what proves
 * possession is the tag over it, not knowledge of it.
 *
 * Nothing decrypted is ever sent back. Returning the opened challenge would
 * hand an observer a matched plaintext and ciphertext for free, which is the
 * one thing the obvious version of this protocol gets wrong.
 */

export const CHALLENGE_BYTES = 16;
export const CONNECTION_SALT_BYTES = 16;

export const HANDSHAKE_CHALLENGE = "e2ee.challenge";
export const HANDSHAKE_PROOF = "e2ee.proof";
export const HANDSHAKE_READY = "e2ee.ready";

/**
 * Why a connection was closed when the key it was using stopped being the key.
 *
 * Setting a new passphrase, or deleting the tab that holds one, has to reach
 * the far end somehow. Without this the remote page keeps a connection it can
 * no longer read anything on, and only a reload tells it why. Closing with a
 * code it recognises turns that into one unsealed bootstrap request: either it
 * is asked for the new passphrase, or it learns encryption is off.
 */
export const KEY_CHANGED_CLOSE_CODE = 4001;

/**
 * What each side's proof is bound to.
 *
 * The role is in here so that the server's proof can never be replayed as the
 * client's -- without it, an observer could echo the challenge frame back and
 * pass for someone holding the key.
 *
 * The fingerprint is in here so that a proof made under one key cannot be
 * presented under another, which is what makes rotation a clean break rather
 * than a window where both work.
 */
export function handshakeAad(role: "server" | "client", fingerprint: string): Uint8Array {
  return new TextEncoder().encode(`promptor/e2ee/v1|${role}|${fingerprint}`);
}

export type HandshakeChallenge = {
  type: typeof HANDSHAKE_CHALLENGE;
  /** Base64. Salts the per-connection, per-direction key derivation. */
  connectionSalt: string;
  /** Base64. Random and meaningless; the tag over it is the proof. */
  challenge: string;
  /** Base64. Opening it is how the client knows the far end holds the key. */
  serverProof: string;
  /** So a client holding several keys knows which one to try, and a client holding the wrong one is told plainly. */
  fingerprint: string;
};

/** Why a handshake did not complete, in the terms the reader needs. */
export type HandshakeFailure = "wrong-key" | "malformed" | "not-required";

export function challengeIsWellFormed(value: unknown): value is HandshakeChallenge {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return message.type === HANDSHAKE_CHALLENGE
    && typeof message.connectionSalt === "string" && message.connectionSalt.length > 0
    && typeof message.challenge === "string" && message.challenge.length > 0
    && typeof message.serverProof === "string" && message.serverProof.length > 0
    && typeof message.fingerprint === "string" && message.fingerprint.length > 0;
}

/**
 * Which messages a connection may send before it has proved itself.
 *
 * Only the proof. A connection that has not shown it holds the key must not be
 * able to subscribe, type into a terminal, or read a tab -- and the check is
 * here, in one place, rather than spread across the handlers where a new
 * message type could quietly be added without one.
 */
export function allowedBeforeHandshake(type: unknown): boolean {
  return type === HANDSHAKE_PROOF;
}
