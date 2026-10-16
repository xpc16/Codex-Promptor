import { HANDSHAKE_CHALLENGE, HANDSHAKE_READY, challengeIsWellFormed, negotiatedDictionary, type HandshakeChallenge, type HandshakeProof, type HandshakeReady } from "../shared/e2ee-handshake.js";
import { DICTIONARY_D1, DICTIONARY_DIGEST } from "../shared/e2ee-dictionary.js";
import { decodeBase64 } from "../shared/e2ee-keys.js";
import { answerChallenge, forgetKey, recallKey, rememberKey, type SessionKey } from "./e2ee-client.js";
import { codecWithin, loadCodec, type Codec } from "./e2ee-codec.js";
import { ClientWire, DICTIONARY_FAILED_CLOSE_CODE, connectionWireKeys } from "./e2ee-wire.js";

/**
 * One key per machine, and one place that answers that machine's challenges.
 *
 * A page has several sockets to a machine -- the navigation one and the
 * terminal one behind each tab -- and all are challenged. Neither is a good
 * owner of the key: the first to connect would decide, and a reconnect would
 * have to find it again. So the key lives here and the sockets ask.
 *
 * And a page can talk to several machines at once
 * (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md §10), each with its own
 * salt and usually its own passphrase. That is why this is a class: one gate
 * per machine, so a key or a counter can never cross from one to another.
 * The module-level functions below are the gate of the machine serving the
 * page, which is all a single-machine page ever needs.
 */

export type E2eeRequirement = { required: boolean; fingerprint?: string };

export type E2eeState = {
  required: boolean;
  /** Which key the server is asking for, so a page holding an old one can be told. */
  fingerprint: string | null;
  /**
   * Whether a challenge has actually been answered.
   *
   * Not "a key was typed". Deriving a key from the wrong passphrase succeeds --
   * PBKDF2 has no idea what the right one is -- so a page that hid its prompt
   * the moment something was entered would report success for any input and
   * only find out later, when some other socket happened to be challenged.
   * Only the far end can say, and this is where it having said so is recorded.
   */
  proved: boolean;
  /** Set when a challenge could not be answered, and cleared when a new key is offered. */
  rejected: boolean;
};

type GateSocket = { send: (data: any) => void; readyState?: number; close?: (code?: number, reason?: string) => void };
type Waiting = { socket: GateSocket; challenge: HandshakeChallenge };

/**
 * What this page knows about one socket.
 *
 * The challenge is kept because its salt is what the data-plane keys are
 * derived from, and that derivation only happens once the far end has said the
 * handshake passed -- there is no point deriving keys for a connection that is
 * about to be closed for holding the wrong passphrase.
 */
type SocketState = {
  challenge: HandshakeChallenge | null;
  wire: ClientWire | null;
  /** The dictionary digest this page put in its proof, so `ready` can be checked against it. */
  offeredDictionary: string | null;
  /**
   * Called when the far end confirms the handshake. Every subscription a page
   * sent on open was refused while it was still unproved, so this is where a
   * socket asks for its stream again.
   */
  onReady: (() => void) | null;
};

/**
 * The compression codec, once it has loaded, and whether this page still
 * trusts the dictionary. Shared by every gate: it is code, not a secret.
 *
 * A frame flagged as dictionary-compressed that did not inflate means the two
 * ends agreed on a digest and hold different bytes anyway. That is a bug to
 * fix, not a condition to retry: from then on this page offers no dictionary,
 * and every reconnect compresses without one.
 */
let codec: Codec | null = null;
let dictionaryTrusted = true;

/** Told by a socket's close handler; see DICTIONARY_FAILED_CLOSE_CODE. */
export function noteSocketClosed(code: number): void {
  if (code === DICTIONARY_FAILED_CLOSE_CODE) dictionaryTrusted = false;
}

/**
 * How long a handshake waits for the codec chunk before answering without
 * a dictionary. It is a one-time fetch of a few kilobytes, cached for good
 * (static-cache.ts), so this only ever bites on the first connection of a
 * slow first visit -- and then only costs that connection the dictionary.
 */
const CODEC_WAIT_MS = 1_500;

/** A socket that closed while the reader was typing has nothing left to prove. */
const isOpen = (socket: GateSocket) => socket.readyState === undefined || socket.readyState === 1;

/**
 * The digest to put in the proof: the server listed the one this page holds,
 * the page still trusts it, and the codec that can use it is here.
 */
async function dictionaryToOffer(challenge: HandshakeChallenge): Promise<string | null> {
  if (!dictionaryTrusted) return null;
  const agreed = negotiatedDictionary(DICTIONARY_DIGEST, challenge.dictionaries ?? []);
  if (!agreed) return null;
  codec ??= await codecWithin(CODEC_WAIT_MS);
  return codec ? agreed : null;
}

export class E2eeGate {
  private readonly sockets = new WeakMap<object, SocketState>();
  private state: E2eeState = { required: false, fingerprint: null, proved: false, rejected: false };
  private key: SessionKey | null = null;
  /**
   * Challenges that arrived before there was a key to answer them with.
   *
   * A page is challenged the moment it connects, which is before the reader has
   * typed anything. Without this the challenge is simply lost: the passphrase is
   * accepted, nothing answers, and the connection sits unproved until some other
   * socket is challenged -- which is what made a wrong key look like it worked
   * until the next conversation was opened.
   */
  private waiting: Waiting[] = [];
  private readonly listeners = new Set<(next: E2eeState) => void>();

  private stateFor(socket: GateSocket): SocketState {
    let entry = this.sockets.get(socket as object);
    if (!entry) { entry = { challenge: null, wire: null, offeredDictionary: null, onReady: null }; this.sockets.set(socket as object, entry); }
    return entry;
  }

  private publish(next: Partial<E2eeState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener(this.state);
  }

  e2eeState(): E2eeState { return this.state; }

  /** The key HTTP seals with. Null while encryption is off or none has been given. */
  currentKey(): SessionKey | null { return this.key; }

  observe(listener: (next: E2eeState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Registers what to do once this socket is proved. Safe to call before it connects. */
  attachSocket(socket: GateSocket, onReady: () => void): void {
    this.stateFor(socket).onReady = onReady;
  }

  /**
   * Sends on a socket, sealed if that socket has reached its data plane.
   *
   * Plaintext until the far end confirms the handshake, and encrypted from then
   * on. That boundary has to be exactly here: a frame sealed before the server
   * installed its own keys would be dropped, and a dropped frame is a counter
   * the two ends no longer agree on.
   *
   * And nothing at all in between. A connection that has not proved itself is
   * answered with silence -- the far end refuses every message but the proof --
   * so a frame sent in that window is bytes paid for and thrown away. Measured
   * on the tunnel over 38 minutes: 55 of 75 subscribes, about 38 kB, every one
   * of them re-sent as soon as the handshake landed. Dropping them here changes
   * nothing about what arrives, only about what is paid for.
   */
  send(socket: GateSocket, text: string): void {
    const wire = this.sockets.get(socket as object)?.wire;
    if (wire) { wire.send(text); return; }
    if (this.state.required) return;
    try { socket.send(text); } catch { /* closed under us */ }
  }

  /**
   * Turns whatever arrived into a message, or null when there is nothing for the
   * caller: a handshake frame the gate consumed, or a frame that did not open.
   */
  async receive(socket: GateSocket, data: unknown): Promise<any | null> {
    const wire = this.sockets.get(socket as object)?.wire;
    if (wire && typeof data !== "string") {
      const text = await wire.open(data);
      if (text === null) return null;
      try { return JSON.parse(text); } catch { return null; }
    }
    let message: any;
    try { message = JSON.parse(String(data)); } catch { return null; }
    return await this.handleMessage(socket, message) ? null : message;
  }

  /**
   * What bootstrap said, and the stored key if it is still the one being asked
   * for. A key from before a rotation is dropped rather than tried: being asked
   * for the passphrase again is a better failure than a page that cannot connect
   * and does not say why.
   */
  async applyRequirement(requirement: E2eeRequirement | undefined): Promise<void> {
    if (!requirement?.required) {
      this.key = null;
      this.waiting = [];
      this.publish({ required: false, fingerprint: null, proved: false, rejected: false });
      return;
    }
    const fingerprint = requirement.fingerprint ?? null;
    // Encryption is on, so there will be a challenge; start fetching the codec
    // now rather than when the challenge is waiting on it.
    void loadCodec().then((loaded) => { codec = loaded; });
    if (this.key && fingerprint && this.key.fingerprint !== fingerprint) this.key = null;
    if (!this.key) this.key = await recallKey(fingerprint);
    this.publish({ required: true, fingerprint, rejected: false });
    // A remembered key still has to prove itself; it is only a candidate.
    if (this.key) await this.answerWaiting();
  }

  /**
   * Answers every challenge that is still waiting.
   *
   * Deliberately tolerant of the list, because the list is not tidy. A page
   * reconnects while the reader is typing -- after bootstrap, on a tab change --
   * and leaves a challenge behind on a socket that is already gone. Sending to
   * that socket throws, and the first version let the throw abandon the loop, so
   * the live connection never got its answer and a correct key looked like it
   * had done nothing until the page was reloaded.
   */
  private async answerWaiting(): Promise<void> {
    const key = this.key;
    if (!key) return;
    const pending = this.waiting.filter((entry) => isOpen(entry.socket));
    this.waiting = [];
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index]!;
      const answer = await answerChallenge(key, entry.challenge);
      // Any challenge that cannot be answered means this key does not work.
      // Trying to tell a wrong key from a stale challenge by fingerprint cannot
      // be done -- a wrong passphrase derives a fingerprint that matches neither
      // -- and the attempt stopped a wrong key being reported at all, which is
      // the whole point. A challenge left over from a rotation costs one extra
      // prompt; a wrong key that is never reported costs the reader the feature.
      if (!answer) {
        // Put back what was not answered. Nothing was sent under the wrong key,
        // so the far end is still holding each of these challenges open -- and
        // without this, correcting a typo left the reader with no socket to
        // answer and a prompt that would not go away until they reloaded.
        this.waiting = pending.slice(index).filter((candidate) => isOpen(candidate.socket));
        await this.dropKey();
        return;
      }
      const offered = await dictionaryToOffer(entry.challenge);
      this.stateFor(entry.socket).offeredDictionary = offered;
      const proof: HandshakeProof = { ...answer, ...(offered ? { dictionary: offered } : {}) } as HandshakeProof;
      // It can close between the check above and here; one dead socket must not
      // decide anything for the others.
      try { entry.socket.send(JSON.stringify(proof)); } catch { /* gone */ }
    }
  }

  /**
   * Takes a candidate key. Deliberately does not report success: whether it is
   * the right key is not knowable here, and saying so would be the bug this
   * separation exists to prevent.
   */
  async useKey(next: SessionKey, remember = true): Promise<void> {
    this.key = next;
    this.publish({ rejected: false });
    // Answered before it is stored, and stored without being waited on. Proving
    // is what the reader is waiting for; remembering is a convenience for next
    // time, and IndexedDB can be blocked or absent -- in a private window, or
    // behind another tab holding the database -- in ways that never resolve.
    await this.answerWaiting();
    if (remember) void rememberKey(next);
  }

  /**
   * Forgets the key without forgetting what is waiting on one: the challenges
   * outlive it, because they belong to sockets that are still open.
   */
  async dropKey(): Promise<void> {
    const fingerprint = this.key?.fingerprint ?? this.state.fingerprint;
    this.key = null;
    await forgetKey(fingerprint);
    this.publish({ proved: false, rejected: true });
  }

  /**
   * Answers a challenge on a socket's behalf, or holds it until there is a key.
   *
   * Returns whether the message belonged to this gate, so a caller can pass
   * everything else through untouched.
   */
  async handleMessage(socket: GateSocket, message: any): Promise<boolean> {
    if (message?.type === HANDSHAKE_READY) {
      // The only place a page learns its key is the right one, and the last
      // frame on this socket that is not sealed.
      this.publish({ proved: true, rejected: false });
      const entry = this.stateFor(socket);
      if (this.key && entry.challenge) {
        const keys = await connectionWireKeys(this.key.master, decodeBase64(entry.challenge.connectionSalt));
        // The dictionary is on only when the server confirmed the very digest
        // this page offered. Anything else -- a confirmation nobody asked for,
        // a different digest -- is treated as none.
        const confirmed = (message as HandshakeReady).dictionary;
        const dictionary = entry.offeredDictionary && confirmed === entry.offeredDictionary && codec ? DICTIONARY_D1 : null;
        entry.wire = new ClientWire(socket, keys.toClient, keys.toServer, { codec, dictionary });
      }
      entry.onReady?.();
      return true;
    }
    if (message?.type !== HANDSHAKE_CHALLENGE) return false;
    if (!challengeIsWellFormed(message)) return true;
    this.publish({ required: true, fingerprint: message.fingerprint });
    this.stateFor(socket).challenge = message;
    this.waiting = [...this.waiting.filter((entry) => entry.socket !== socket && isOpen(entry.socket)), { socket, challenge: message }];
    await this.answerWaiting();
    return true;
  }
}

/** The machine serving this page. */
export const homeGate = new E2eeGate();

export const attachSocket = (socket: GateSocket, onReady: () => void): void => homeGate.attachSocket(socket, onReady);
export const gateSend = (socket: GateSocket, text: string): void => homeGate.send(socket, text);
export const gateReceive = (socket: GateSocket, data: unknown): Promise<any | null> => homeGate.receive(socket, data);
export const e2eeState = (): E2eeState => homeGate.e2eeState();
export const currentKey = (): SessionKey | null => homeGate.currentKey();
export const observeE2ee = (listener: (next: E2eeState) => void): (() => void) => homeGate.observe(listener);
export const applyRequirement = (requirement: E2eeRequirement | undefined): Promise<void> => homeGate.applyRequirement(requirement);
export const useKey = (next: SessionKey, remember = true): Promise<void> => homeGate.useKey(next, remember);
export const dropKey = (): Promise<void> => homeGate.dropKey();
export const handleGateMessage = (socket: GateSocket, message: any): Promise<boolean> => homeGate.handleMessage(socket, message);
