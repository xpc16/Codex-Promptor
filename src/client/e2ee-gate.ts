import { HANDSHAKE_CHALLENGE, HANDSHAKE_READY, challengeIsWellFormed, type HandshakeChallenge } from "../shared/e2ee-handshake.js";
import { decodeBase64 } from "../shared/e2ee-keys.js";
import { answerChallenge, forgetKey, recallKey, rememberKey, type SessionKey } from "./e2ee-client.js";
import { ClientWire, connectionWireKeys } from "./e2ee-wire.js";

/**
 * One key for the whole page, and one place that answers challenges with it.
 *
 * There are two sockets -- the navigation one and the terminal one behind each
 * tab -- and both are challenged. Neither is a good owner of the key: the first
 * to connect would decide, and a reconnect would have to find it again. So the
 * key lives here and the sockets ask.
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
  /**
   * Called when the far end confirms the handshake. Every subscription a page
   * sent on open was refused while it was still unproved, so this is where a
   * socket asks for its stream again.
   */
  onReady: (() => void) | null;
};

const sockets = new WeakMap<object, SocketState>();

const stateFor = (socket: GateSocket): SocketState => {
  let entry = sockets.get(socket as object);
  if (!entry) { entry = { challenge: null, wire: null, onReady: null }; sockets.set(socket as object, entry); }
  return entry;
};

/** Registers what to do once this socket is proved. Safe to call before it connects. */
export function attachSocket(socket: GateSocket, onReady: () => void): void {
  stateFor(socket).onReady = onReady;
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
export function gateSend(socket: GateSocket, text: string): void {
  const wire = sockets.get(socket as object)?.wire;
  if (wire) { wire.send(text); return; }
  if (state.required) return;
  try { socket.send(text); } catch { /* closed under us */ }
}

/**
 * Turns whatever arrived into a message, or null when there is nothing for the
 * caller: a handshake frame the gate consumed, or a frame that did not open.
 */
export async function gateReceive(socket: GateSocket, data: unknown): Promise<any | null> {
  const wire = sockets.get(socket as object)?.wire;
  if (wire && typeof data !== "string") {
    const text = await wire.open(data);
    if (text === null) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  let message: any;
  try { message = JSON.parse(String(data)); } catch { return null; }
  return await handleGateMessage(socket, message) ? null : message;
}

let state: E2eeState = { required: false, fingerprint: null, proved: false, rejected: false };
let key: SessionKey | null = null;
/**
 * Challenges that arrived before there was a key to answer them with.
 *
 * A page is challenged the moment it connects, which is before the reader has
 * typed anything. Without this the challenge is simply lost: the passphrase is
 * accepted, nothing answers, and the connection sits unproved until some other
 * socket is challenged -- which is what made a wrong key look like it worked
 * until the next conversation was opened.
 */
let waiting: Waiting[] = [];
const listeners = new Set<(next: E2eeState) => void>();

const publish = (next: Partial<E2eeState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener(state);
};

export function e2eeState(): E2eeState { return state; }

/** The key HTTP seals with. Null while encryption is off or none has been given. */
export function currentKey(): SessionKey | null { return key; }

export function observeE2ee(listener: (next: E2eeState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * What bootstrap said, and the stored key if it is still the one being asked
 * for. A key from before a rotation is dropped rather than tried: being asked
 * for the passphrase again is a better failure than a page that cannot connect
 * and does not say why.
 */
export async function applyRequirement(requirement: E2eeRequirement | undefined): Promise<void> {
  if (!requirement?.required) {
    key = null;
    waiting = [];
    publish({ required: false, fingerprint: null, proved: false, rejected: false });
    return;
  }
  const fingerprint = requirement.fingerprint ?? null;
  if (key && fingerprint && key.fingerprint !== fingerprint) key = null;
  if (!key) key = await recallKey(fingerprint);
  publish({ required: true, fingerprint, rejected: false });
  // A remembered key still has to prove itself; it is only a candidate.
  if (key) await answerWaiting();
}

/** A socket that closed while the reader was typing has nothing left to prove. */
const isOpen = (socket: GateSocket) => socket.readyState === undefined || socket.readyState === 1;

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
async function answerWaiting(): Promise<void> {
  if (!key) return;
  const pending = waiting.filter((entry) => isOpen(entry.socket));
  waiting = [];
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
      waiting = pending.slice(index).filter((candidate) => isOpen(candidate.socket));
      await dropKey();
      return;
    }
    // It can close between the check above and here; one dead socket must not
    // decide anything for the others.
    try { entry.socket.send(JSON.stringify(answer)); } catch { /* gone */ }
  }
}

/**
 * Takes a candidate key. Deliberately does not report success: whether it is
 * the right key is not knowable here, and saying so would be the bug this
 * separation exists to prevent.
 */
export async function useKey(next: SessionKey, remember = true): Promise<void> {
  key = next;
  publish({ rejected: false });
  // Answered before it is stored, and stored without being waited on. Proving
  // is what the reader is waiting for; remembering is a convenience for next
  // time, and IndexedDB can be blocked or absent -- in a private window, or
  // behind another tab holding the database -- in ways that never resolve.
  await answerWaiting();
  if (remember) void rememberKey(next);
}

/**
 * Forgets the key without forgetting what is waiting on one: the challenges
 * outlive it, because they belong to sockets that are still open.
 */
export async function dropKey(): Promise<void> {
  key = null;
  await forgetKey();
  publish({ proved: false, rejected: true });
}

/**
 * Answers a challenge on a socket's behalf, or holds it until there is a key.
 *
 * Returns whether the message belonged to this gate, so a caller can pass
 * everything else through untouched.
 */
export async function handleGateMessage(socket: GateSocket, message: any): Promise<boolean> {
  if (message?.type === HANDSHAKE_READY) {
    // The only place a page learns its key is the right one, and the last
    // frame on this socket that is not sealed.
    publish({ proved: true, rejected: false });
    const entry = stateFor(socket);
    if (key && entry.challenge) {
      const keys = await connectionWireKeys(key.master, decodeBase64(entry.challenge.connectionSalt));
      entry.wire = new ClientWire(socket, keys.toClient, keys.toServer);
    }
    entry.onReady?.();
    return true;
  }
  if (message?.type !== HANDSHAKE_CHALLENGE) return false;
  if (!challengeIsWellFormed(message)) return true;
  publish({ required: true, fingerprint: message.fingerprint });
  stateFor(socket).challenge = message;
  waiting = [...waiting.filter((entry) => entry.socket !== socket && isOpen(entry.socket)), { socket, challenge: message }];
  await answerWaiting();
  return true;
}
