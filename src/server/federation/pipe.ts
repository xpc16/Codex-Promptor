import WebSocket from "ws";
import { sendableCloseCode, sendableCloseReason } from "../../shared/federation-protocol.js";

/**
 * Joining two WebSockets end to end.
 *
 * Used wherever a page's socket meets another one that carries the same
 * conversation onward: a hub reaching its own `/ws` for a member, and a
 * member reaching the hub for its local page. Text stays text and binary
 * stays binary -- the page tells a JSON frame from a sealed one by exactly
 * that -- and a close code travels across unchanged, because codes like 4001
 * (the key changed) mean something to the page at the far end.
 */

/** More than this waiting for a slow reader, and the connection is dropped rather than buffered without end. */
export const SOCKET_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/** Frames the near side sends before the far side has opened. A subscribe and a few keystrokes, not a backlog. */
export const EARLY_QUEUE_BYTES = 256 * 1024;

type Message = { data: Buffer; binary: boolean };

const toBuffer = (data: WebSocket.RawData): Buffer => Buffer.isBuffer(data)
  ? data
  : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);

export function closeQuietly(socket: WebSocket | null | undefined, code?: number, reason?: unknown): void {
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) socket.close(sendableCloseCode(code), sendableCloseReason(reason));
  } catch { /* already gone */ }
}

/**
 * Relays `near` (already open) to whatever `far` resolves to.
 *
 * Frames from `near` that arrive before `far` opens are queued and sent in
 * order once it does. If `far` never opens, `near` is closed with
 * `failureCode`, so the page sees a reason rather than a hang.
 */
export function relaySockets(near: WebSocket, far: Promise<WebSocket>, failureCode: number, failureReason = "unavailable"): void {
  let farSocket: WebSocket | null = null;
  let finished = false;
  const early: Message[] = [];
  let earlyBytes = 0;

  const finish = (code: number, reason: unknown, from: "near" | "far" | "none") => {
    if (finished) return;
    finished = true;
    if (from !== "near") closeQuietly(near, code, reason);
    if (from !== "far") closeQuietly(farSocket, code, reason);
  };

  const sendTo = (target: WebSocket, message: Message): boolean => {
    if (target.readyState !== WebSocket.OPEN) return false;
    if (target.bufferedAmount > SOCKET_HIGH_WATER_BYTES) {
      // A reader this far behind is better served by reconnecting and taking
      // a fresh snapshot than by a queue that only grows.
      finish(1013, "slow consumer", "none");
      return false;
    }
    target.send(message.data, { binary: message.binary });
    return true;
  };

  near.on("message", (data, isBinary) => {
    const message = { data: toBuffer(data), binary: isBinary };
    if (farSocket) { sendTo(farSocket, message); return; }
    earlyBytes += message.data.length;
    if (earlyBytes > EARLY_QUEUE_BYTES) { finish(1013, "too much before open", "none"); return; }
    early.push(message);
  });
  near.on("close", (code, reason) => finish(code, reason, "near"));
  near.on("error", () => finish(1011, "error", "none"));

  far.then((socket) => {
    if (finished) { closeQuietly(socket, 1000, "page left"); return; }
    farSocket = socket;
    socket.on("message", (data, isBinary) => { sendTo(near, { data: toBuffer(data), binary: isBinary }); });
    socket.on("close", (code, reason) => finish(code, reason, "far"));
    socket.on("error", () => finish(1011, "error", "none"));
    for (const message of early.splice(0)) sendTo(socket, message);
  }, () => finish(failureCode, failureReason, "none"));
}
