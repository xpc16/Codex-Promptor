import { HANDSHAKE_CHALLENGE, HANDSHAKE_READY, challengeIsWellFormed, type HandshakeChallenge } from "../shared/e2ee-handshake.js";
import { answerChallenge, forgetKey, recallKey, rememberKey, type SessionKey } from "./e2ee-client.js";

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

type Waiting = { socket: { send: (data: string) => void }; challenge: HandshakeChallenge };

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

/**
 * Answers every challenge that is still waiting.
 *
 * The first failure drops the key: all of these are from the same server under
 * the same fingerprint, so one of them failing means none of them can succeed.
 */
async function answerWaiting(): Promise<void> {
  if (!key) return;
  const pending = waiting;
  waiting = [];
  for (const entry of pending) {
    const answer = await answerChallenge(key, entry.challenge);
    if (!answer) { await dropKey(); return; }
    entry.socket.send(JSON.stringify(answer));
  }
}

/**
 * Takes a candidate key. Deliberately does not report success: whether it is
 * the right key is not knowable here, and saying so would be the bug this
 * separation exists to prevent.
 */
export async function useKey(next: SessionKey, remember = true): Promise<void> {
  key = next;
  if (remember) await rememberKey(next);
  publish({ rejected: false });
  await answerWaiting();
}

export async function dropKey(): Promise<void> {
  key = null;
  waiting = [];
  await forgetKey();
  publish({ proved: false, rejected: true });
}

/**
 * Answers a challenge on a socket's behalf, or holds it until there is a key.
 *
 * Returns whether the message belonged to this gate, so a caller can pass
 * everything else through untouched.
 */
export async function handleGateMessage(socket: { send: (data: string) => void }, message: any): Promise<boolean> {
  if (message?.type === HANDSHAKE_READY) {
    // The only place a page learns its key is the right one.
    publish({ proved: true, rejected: false });
    return true;
  }
  if (message?.type !== HANDSHAKE_CHALLENGE) return false;
  if (!challengeIsWellFormed(message)) return true;
  publish({ required: true, fingerprint: message.fingerprint });
  waiting = [...waiting.filter((entry) => entry.socket !== socket), { socket, challenge: message }];
  await answerWaiting();
  return true;
}
