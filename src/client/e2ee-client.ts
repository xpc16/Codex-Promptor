import { GCM_TAG_BYTES } from "../shared/e2ee-envelope.js";
import {
  KEY_LABELS,
  decodeBase64,
  encodeBase64,
  keyFingerprint,
  type KeyPurpose,
} from "../shared/e2ee-keys.js";
import {
  HANDSHAKE_PROOF,
  handshakeAad,
  type HandshakeChallenge,
} from "../shared/e2ee-handshake.js";

/**
 * The browser half of the key: deriving it, keeping it, and using it to answer
 * a challenge.
 *
 * The passphrase is typed here and never sent. Everything below exists so that
 * it can be turned into the same key the other end derived, checked against
 * what that end proves, and kept across reloads without ever being readable
 * again -- not by this code, and not by anything that manages to run in this
 * page.
 */

export type SessionKey = {
  /** Non-extractable. Subkeys come from it; it cannot be read back. */
  master: CryptoKey;
  fingerprint: string;
};

const KEY_STORE = "promptor-e2ee";
const KEY_RECORD = "master";

/**
 * PBKDF2 rather than something memory-hard, because this has to run in both a
 * browser and Node and WebCrypto offers PBKDF2, HKDF and ECDH. The raw master
 * bits exist for the few lines between deriving them and importing them
 * unextractable; there is no way to skip that step, and everything after it
 * holds a key that cannot be read.
 */
export async function deriveSessionKey(passphrase: string, salt: string, iterations: number): Promise<SessionKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase.normalize("NFC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: decodeBase64(salt) as BufferSource, iterations, hash: "SHA-256" },
    material,
    256,
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bits));
  const master = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
  return { master, fingerprint: keyFingerprint(digest) };
}

/**
 * `deriveKey` rather than `deriveBits`, so a subkey is born unextractable and
 * its bytes never exist in this page at all.
 */
async function subKey(master: CryptoKey, purpose: KeyPurpose): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_LABELS[purpose]) },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(key: CryptoKey, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: GCM_TAG_BYTES * 8 },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(sealed);
}

/** Null for a failed open, which here is the ordinary outcome of a wrong key. */
async function open(key: CryptoKey, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: aad as BufferSource, tagLength: GCM_TAG_BYTES * 8 },
      key,
      sealed as BufferSource,
    );
    return new Uint8Array(plain);
  } catch {
    return null;
  }
}

/**
 * Answering a challenge, and checking the far end before doing so.
 *
 * Null means the server's own proof did not open, which is what a wrong
 * passphrase looks like from here -- and the point at which to say so, before
 * anything of this reader's has been sent anywhere.
 */
export async function answerChallenge(key: SessionKey, challenge: HandshakeChallenge): Promise<{ type: string; proof: string } | null> {
  if (challenge.fingerprint !== key.fingerprint) return null;
  const auth = await subKey(key.master, "auth");
  const nonce = new Uint8Array(12);
  const opened = await open(auth, nonce, decodeBase64(challenge.serverProof), handshakeAad("server", challenge.fingerprint));
  if (!opened) return null;
  const proof = await seal(auth, nonce, opened, handshakeAad("client", challenge.fingerprint));
  return { type: HANDSHAKE_PROOF, proof: encodeBase64(proof) };
}

/**
 * Kept in IndexedDB because a CryptoKey survives structured cloning while its
 * bytes do not become readable. localStorage would mean holding the passphrase
 * or the key as text, which is the thing this is arranged to avoid.
 */
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_STORE, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(KEY_STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await database();
    return await new Promise<T | null>((resolve) => {
      const request = run(db.transaction(KEY_STORE, mode).objectStore(KEY_STORE));
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    // A private window, blocked site data, or no IndexedDB at all. The reader
    // types the passphrase again next time, which is worse but not broken.
    return null;
  }
}

export async function rememberKey(key: SessionKey): Promise<void> {
  await transact("readwrite", (store) => store.put(key as never, KEY_RECORD) as IDBRequest<unknown>);
}

export async function recallKey(fingerprint: string | null): Promise<SessionKey | null> {
  const stored = await transact<SessionKey>("readonly", (store) => store.get(KEY_RECORD) as IDBRequest<SessionKey>);
  if (!stored?.master || typeof stored.fingerprint !== "string") return null;
  // A key from before a rotation is not this key. Dropping it here is what
  // turns "the page is broken" into "it asks for the passphrase again".
  return fingerprint && stored.fingerprint !== fingerprint ? null : stored;
}

export async function forgetKey(): Promise<void> {
  await transact("readwrite", (store) => store.delete(KEY_RECORD) as IDBRequest<undefined>);
}
