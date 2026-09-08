import { HANDSHAKE_CHALLENGE, HANDSHAKE_READY, challengeIsWellFormed } from "../shared/e2ee-handshake.js";
import { answerChallenge, forgetKey, recallKey, rememberKey, type SessionKey } from "./e2ee-client.js";

/**
 * One key for the whole page, and one place that answers challenges with it.
 *
 * There are two sockets -- the navigation one and the terminal one behind each
 * tab -- and both are challenged. Neither is a good owner of the key: the
 * first to connect would decide, and a reconnect would have to find it again.
 * So the key lives here and the sockets ask.
 */

export type E2eeRequirement = { required: boolean; fingerprint?: string };

export type E2eeState = {
  required: boolean;
  /** Which key the server is asking for, so a page holding an old one can be told. */
  fingerprint: string | null;
  /** True once a key is held. Not that it is the right one -- a challenge decides that. */
  unlocked: boolean;
  /** Set when a challenge could not be answered, and cleared when a new key is offered. */
  rejected: boolean;
};

let state: E2eeState = { required: false, fingerprint: null, unlocked: false, rejected: false };
let key: SessionKey | null = null;
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
    publish({ required: false, fingerprint: null, unlocked: false, rejected: false });
    return;
  }
  const fingerprint = requirement.fingerprint ?? null;
  if (key && fingerprint && key.fingerprint !== fingerprint) key = null;
  if (!key) key = await recallKey(fingerprint);
  publish({ required: true, fingerprint, unlocked: Boolean(key), rejected: false });
}

export async function useKey(next: SessionKey, remember = true): Promise<void> {
  key = next;
  if (remember) await rememberKey(next);
  publish({ unlocked: true, rejected: false });
}

export async function dropKey(): Promise<void> {
  key = null;
  await forgetKey();
  publish({ unlocked: false, rejected: true });
}

/**
 * Answers a challenge on a socket's behalf.
 *
 * Returns whether the message belonged to this gate, so a caller can pass
 * everything else through untouched. A challenge that cannot be answered drops
 * the stored key and says so: that is a wrong passphrase, and the page should
 * ask again rather than sit on a connection that will never open.
 */
export async function handleGateMessage(socket: { send: (data: string) => void }, message: any): Promise<boolean> {
  if (message?.type === HANDSHAKE_READY) return true;
  if (message?.type !== HANDSHAKE_CHALLENGE) return false;
  if (!challengeIsWellFormed(message)) return true;
  publish({ required: true, fingerprint: message.fingerprint });
  if (!key) return true;
  const answer = await answerChallenge(key, message);
  if (!answer) { await dropKey(); return true; }
  socket.send(JSON.stringify(answer));
  return true;
}
