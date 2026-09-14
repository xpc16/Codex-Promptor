import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeBase64 } from "../shared/e2ee-keys.js";
import { HANDSHAKE_READY, handshakeAad } from "../shared/e2ee-handshake.js";
import { deriveMasterKey, fingerprintOf, subKey } from "../server/e2ee-key-material.js";
import { handshakeAnswered, open, seal, startHandshake } from "../server/e2ee-session.js";
import { answerChallenge, deriveSessionKey } from "./e2ee-client.js";
import { applyRequirement, attachSocket, e2eeState, gateReceive, gateSend, handleGateMessage, noteSocketClosed, useKey } from "./e2ee-gate.js";
import { DICTIONARY_FAILED_CLOSE_CODE } from "./e2ee-wire.js";
import { loadCodec } from "./e2ee-codec.js";
import { DICTIONARY_D1, DICTIONARY_DIGEST } from "../shared/e2ee-dictionary.js";
import { FLAG_DICTIONARY } from "../shared/e2ee-envelope.js";
import { ServerWire } from "../server/e2ee-wire.js";

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

describe("the gate, on a key that has not proved itself", () => {
  // The gate is one object for the whole page, so a test that inherits the key
  // a previous one left behind is not testing what it says it is.
  beforeEach(async () => { await applyRequirement({ required: false }); });

  const passphrase = "correct horse battery staple";
  const salt = encodeBase64(new Uint8Array(randomBytes(16)));
  const iterations = 60_000;

  const serverSide = async () => {
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    return { pending: startHandshake(master, fingerprintOf(master)) };
  };

  const socket = () => {
    const sent: any[] = [];
    return { sent, send: (data: string) => sent.push(JSON.parse(data)) };
  };

  it("does not call itself unlocked just because a key was typed", async () => {
    // The bug this replaces: deriving from the wrong passphrase succeeds --
    // PBKDF2 has no idea what the right one is -- so the prompt disappeared for
    // any input at all, and the mistake only surfaced when the next socket
    // happened to be challenged.
    const { pending } = await serverSide();
    const peer = socket();
    await applyRequirement({ required: true, fingerprint: pending.message.fingerprint });
    await handleGateMessage(peer, pending.message);
    await useKey(await deriveSessionKey("口令输错了", salt, iterations), false);

    expect(e2eeState().proved).toBe(false);
    expect(e2eeState().rejected).toBe(true);
    expect(peer.sent, "nothing is sent under a key that cannot open the server's proof").toHaveLength(0);
  });

  it("answers a challenge that arrived before the key did", async () => {
    // A page is challenged the moment it connects, which is before the reader
    // has typed anything. Losing that challenge is what made the failure show
    // up one conversation late.
    const { pending } = await serverSide();
    const peer = socket();
    await applyRequirement({ required: true, fingerprint: pending.message.fingerprint });
    await handleGateMessage(peer, pending.message);
    expect(peer.sent).toHaveLength(0);

    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    expect(peer.sent).toHaveLength(1);
    expect(handshakeAnswered(pending, peer.sent[0].proof)).toBe(true);

    // And still not proved until the server says so.
    expect(e2eeState().proved).toBe(false);
    await handleGateMessage(peer, { type: HANDSHAKE_READY });
    expect(e2eeState().proved).toBe(true);
  });
});

describe("the gate, on a list of sockets that is not tidy", () => {
  // The gate is one object for the whole page, so a test that inherits the key
  // a previous one left behind is not testing what it says it is.
  beforeEach(async () => { await applyRequirement({ required: false }); });

  const passphrase = "correct horse battery staple";
  const salt = encodeBase64(new Uint8Array(randomBytes(16)));
  const iterations = 60_000;

  const live = () => {
    const sent: any[] = [];
    return { sent, readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) };
  };
  const dead = () => ({
    readyState: 3,
    send: () => { throw new Error("InvalidStateError: socket is closed"); },
  });

  it("answers the live socket even when a dead one is waiting first", async () => {
    // The reported failure: a page reconnects while the reader is typing, and
    // the throw from the socket that is already gone abandoned the loop, so
    // the connection that mattered never got its answer.
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const first = startHandshake(master, fingerprintOf(master));
    const second = startHandshake(master, fingerprintOf(master));
    const gone = dead();
    const open = live();

    await applyRequirement({ required: true, fingerprint: first.message.fingerprint });
    await handleGateMessage(gone, first.message);
    await handleGateMessage(open, second.message);
    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);

    expect(open.sent, "the socket that is still open was answered").toHaveLength(1);
    expect(handshakeAnswered(second, open.sent[0].proof)).toBe(true);
    expect(e2eeState().rejected, "and nothing was mistaken for a wrong key").toBe(false);
  });

  it("does not pay for frames the far end is going to refuse", async () => {
    // Until the handshake lands, the server answers everything but the proof
    // with silence -- so a subscribe sent on open is bytes on the tunnel that
    // are thrown away and then sent again. Measured over 38 minutes on the
    // real link: 55 of 75 subscribes were exactly that, about 38 kB.
    await applyRequirement({ required: true, fingerprint: "AAAA-BBBB" });
    const open = live();
    gateSend(open, JSON.stringify({ type: "subscribe" }));
    expect(open.sent).toHaveLength(0);
  });

  it("still sends in the clear when there is nothing to prove", async () => {
    // Loopback is told `required: false`, and holding its frames would leave
    // the local page waiting on a handshake that is never going to happen.
    await applyRequirement({ required: false });
    const open = live();
    gateSend(open, JSON.stringify({ type: "subscribe" }));
    expect(open.sent).toHaveLength(1);
  });

  it("sends what was held back once the connection is proved", async () => {
    // Nothing is queued -- the socket asks again on its own -- so what makes
    // this safe is that the far end's "ready" is what triggers the re-ask.
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const current = startHandshake(master, fingerprintOf(master));
    const open = live();
    let asked = 0;

    attachSocket(open, () => { asked += 1; });
    await applyRequirement({ required: true, fingerprint: current.message.fingerprint });
    await handleGateMessage(open, current.message);
    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    await handleGateMessage(open, { type: HANDSHAKE_READY });

    expect(asked, "the socket is told to ask for its stream again").toBe(1);
  });

  it("takes the corrected key without waiting for a reconnect", async () => {
    // Nothing was sent under the wrong key, so the far end is still holding
    // that challenge open. Dropping it here left the reader typing the right
    // passphrase into a prompt that could not act on it.
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const current = startHandshake(master, fingerprintOf(master));
    const open = live();

    await applyRequirement({ required: true, fingerprint: current.message.fingerprint });
    await handleGateMessage(open, current.message);
    await useKey(await deriveSessionKey("口令输错了", salt, iterations), false);
    expect(e2eeState().rejected).toBe(true);

    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    expect(open.sent, "the second attempt reaches the connection the first one could not").toHaveLength(1);
    expect(handshakeAnswered(current, open.sent[0].proof)).toBe(true);
    expect(e2eeState().rejected).toBe(false);
  });

  it("reports a key that cannot answer, whichever key the challenge names", async () => {
    // Telling a wrong key from a stale challenge by fingerprint cannot be
    // done: a wrong passphrase derives one that matches neither. Trying cost
    // the ability to report a wrong key at all.
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    const current = startHandshake(master, fingerprintOf(master));
    const open = live();

    await applyRequirement({ required: true, fingerprint: current.message.fingerprint });
    await handleGateMessage(open, current.message);
    await useKey(await deriveSessionKey("口令输错了", salt, iterations), false);

    expect(e2eeState().rejected).toBe(true);
    expect(e2eeState().proved).toBe(false);
    expect(open.sent).toHaveLength(0);
  });
});

describe("the gate, negotiating the compression dictionary", () => {
  beforeEach(async () => { await applyRequirement({ required: false }); });

  const passphrase = "correct horse battery staple";
  const salt = encodeBase64(new Uint8Array(randomBytes(16)));
  const iterations = 60_000;

  const serverSide = async () => {
    const master = await deriveMasterKey(passphrase, Buffer.from(salt, "base64"), iterations);
    return { master, pending: startHandshake(master, fingerprintOf(master)) };
  };

  const socket = () => {
    const sent: any[] = [];
    const binary: Uint8Array[] = [];
    const closes: number[] = [];
    return {
      sent, binary, closes, readyState: 1,
      send: (data: string | ArrayBuffer) => { if (typeof data === "string") sent.push(JSON.parse(data)); else binary.push(new Uint8Array(data)); },
      close: (code?: number) => { closes.push(code ?? 1005); },
    };
  };

  it("offers the dictionary it holds when the server lists it, and uses it once confirmed", async () => {
    await loadCodec();
    const { master, pending } = await serverSide();
    const peer = socket();
    await applyRequirement({ required: true, fingerprint: pending.message.fingerprint });
    await handleGateMessage(peer, { ...pending.message, dictionaries: [DICTIONARY_DIGEST] });
    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    expect(peer.sent).toHaveLength(1);
    expect(peer.sent[0].dictionary).toBe(DICTIONARY_DIGEST);
    expect(handshakeAnswered(pending, peer.sent[0].proof)).toBe(true);

    await handleGateMessage(peer, { type: HANDSHAKE_READY, dictionary: DICTIONARY_DIGEST });
    // Sealed with the dictionary from the first frame after `ready`...
    gateSend(peer, JSON.stringify({ type: "subscribe", terminalProtocolVersion: 2, tabIds: ["b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b"], snapshots: true, details: true, terminals: {} }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.binary).toHaveLength(1);
    expect(peer.binary[0]![0]! & FLAG_DICTIONARY).toBe(FLAG_DICTIONARY);
    // ...and readable by a server holding the same bytes.
    const server = new ServerWire(pending.keys.toClient, pending.keys.toServer, Buffer.from(DICTIONARY_D1));
    expect(server.open(peer.binary[0]!)).toContain('"type":"subscribe"');
    // And the other way.
    const opened = await gateReceive(peer, new Uint8Array(server.seal(JSON.stringify({ type: "index.changed", index: { tabs: [], groups: [], revision: 1 } }))!));
    expect(opened?.type).toBe("index.changed");
    void master;
  });

  it("offers nothing when the server lists none, or a different one", async () => {
    await loadCodec();
    const { pending } = await serverSide();
    for (const dictionaries of [undefined, [], ["d1:00000000000000000000000000000000"]]) {
      const peer = socket();
      await applyRequirement({ required: true, fingerprint: pending.message.fingerprint });
      await handleGateMessage(peer, { ...pending.message, ...(dictionaries ? { dictionaries } : {}) });
      await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
      expect(peer.sent[0].dictionary).toBeUndefined();
    }
  });

  it("does not turn it on for a confirmation it did not ask for", async () => {
    // A `ready` naming a dictionary this page never offered is treated as
    // none: the server may be confused, or may not be this server.
    await loadCodec();
    const { pending } = await serverSide();
    const peer = socket();
    await applyRequirement({ required: true, fingerprint: pending.message.fingerprint });
    await handleGateMessage(peer, pending.message);
    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    await handleGateMessage(peer, { type: HANDSHAKE_READY, dictionary: DICTIONARY_DIGEST });
    gateSend(peer, JSON.stringify({ type: "subscribe", tabIds: ["b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b"], snapshots: true, details: true, terminals: {} }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(peer.binary[0]![0]! & FLAG_DICTIONARY).toBe(0);
  });

  it("stops offering it after a frame that claimed it failed to open", async () => {
    // Same digest, different bytes, is a bug -- and until it is fixed this
    // page compresses without, rather than reconnecting into the same wall.
    await loadCodec();
    const { pending } = await serverSide();
    const peer = socket();
    await applyRequirement({ required: true, fingerprint: pending.message.fingerprint });
    await handleGateMessage(peer, { ...pending.message, dictionaries: [DICTIONARY_DIGEST] });
    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    await handleGateMessage(peer, { type: HANDSHAKE_READY, dictionary: DICTIONARY_DIGEST });
    // A server whose "same" dictionary is actually different bytes: the
    // same words in a different order, so the frame's back-references land on
    // the wrong ones and inflate "succeeds" into something that is not JSON.
    const other = Buffer.concat([Buffer.from(DICTIONARY_D1.subarray(1800)), Buffer.from(DICTIONARY_D1.subarray(0, 1800))]);
    const server = new ServerWire(pending.keys.toClient, pending.keys.toServer, other);
    const frame = server.seal(JSON.stringify({ type: "index.changed", index: { tabs: [], groups: [], revision: 1, name: "x".repeat(200) } }))!;
    expect(await gateReceive(peer, new Uint8Array(frame))).toBeNull();
    expect(peer.closes).toEqual([DICTIONARY_FAILED_CLOSE_CODE]);
    noteSocketClosed(DICTIONARY_FAILED_CLOSE_CODE);

    const again = socket();
    const { pending: next } = await serverSide();
    await applyRequirement({ required: true, fingerprint: next.message.fingerprint });
    await handleGateMessage(again, { ...next.message, dictionaries: [DICTIONARY_DIGEST] });
    await useKey(await deriveSessionKey(passphrase, salt, iterations), false);
    expect(again.sent[0].dictionary).toBeUndefined();
  });
});
