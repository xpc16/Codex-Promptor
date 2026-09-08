import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeBase64 } from "../shared/e2ee-keys.js";
import { handshakeAad } from "../shared/e2ee-handshake.js";
import { deriveMasterKey, fingerprintOf, subKey } from "../server/e2ee-key-material.js";
import { handshakeAnswered, open, seal, startHandshake } from "../server/e2ee-session.js";
import { answerChallenge, deriveSessionKey } from "./e2ee-client.js";

/**
 * The two halves are written against different crypto libraries -- WebCrypto in
 * the page, node:crypto on the server -- so agreeing in the abstract is not
 * evidence of anything. These run one against the other.
 */
describe("the page and the server deriving the same key", () => {
  const passphrase = "一句只有我知道的话 42";
  const salt = encodeBase64(new Uint8Array(randomBytes(16)));
  const iterations = 60_000; // Lower than production, for a test that has to finish.

  it("arrive at the same fingerprint from the same passphrase", async () => {
    const server = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const page = await deriveSessionKey(passphrase, salt, iterations);
    expect(page.fingerprint).toBe(fingerprintOf(server));
  });

  it("arrive at different ones from different passphrases", async () => {
    const a = await deriveSessionKey(passphrase, salt, iterations);
    const b = await deriveSessionKey("口令输错了", salt, iterations);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("arrive at different ones from the same passphrase under a new salt", async () => {
    // What tells the reader to re-pair after the key is set again.
    const other = encodeBase64(new Uint8Array(randomBytes(16)));
    const a = await deriveSessionKey(passphrase, salt, iterations);
    const b = await deriveSessionKey(passphrase, other, iterations);
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });
});

describe("the page answering the server's challenge", () => {
  const passphrase = "correct horse battery staple";
  const salt = encodeBase64(new Uint8Array(randomBytes(16)));
  const iterations = 60_000;

  const pair = async (pagePassphrase: string) => {
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const pending = startHandshake(master, fingerprintOf(master));
    const page = await deriveSessionKey(pagePassphrase, salt, iterations);
    return { pending, page };
  };

  it("is accepted by the server that set it", async () => {
    const { pending, page } = await pair(passphrase);
    const answer = await answerChallenge(page, pending.message);
    expect(answer).not.toBeNull();
    expect(handshakeAnswered(pending, answer!.proof)).toBe(true);
  });

  it("refuses to answer at all when the passphrase is wrong", async () => {
    // The server's own proof does not open, which is where the reader finds
    // out -- before anything of theirs has been sent anywhere.
    const { pending, page } = await pair("口令输错了");
    expect(await answerChallenge(page, pending.message)).toBeNull();
  });

  it("refuses a challenge naming a key this page does not hold", async () => {
    const { pending, page } = await pair(passphrase);
    expect(await answerChallenge(page, { ...pending.message, fingerprint: "AAAA-BBBB" })).toBeNull();
  });

  it("will not answer a challenge whose proof was made for the other role", async () => {
    // Replaying the server's proof back as the client's is the shortcut an
    // observer would try; the role in the AAD is what closes it.
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const fingerprint = fingerprintOf(master);
    const pending = startHandshake(master, fingerprint);
    expect(handshakeAnswered(pending, pending.message.serverProof)).toBe(false);
  });

  it("agrees with the server on what a sealed message is", async () => {
    // Both libraries, one tag: if the framing differed at all, nothing below
    // the handshake would work either.
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const auth = subKey(master, "auth");
    const nonce = new Uint8Array(12);
    const aad = handshakeAad("server", "TEST-TEST");
    const sealed = seal(auth, nonce, new TextEncoder().encode("hello"), aad);
    expect(open(auth, nonce, sealed, aad)?.toString("utf8")).toBe("hello");
    expect(open(auth, nonce, sealed, handshakeAad("client", "TEST-TEST"))).toBeNull();
  });
});
