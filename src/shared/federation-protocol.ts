/**
 * Several Promptor instances behind one public hostname
 * (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md).
 *
 * One machine is the hub: the hostname points at it. Every other machine is a
 * member and keeps one outbound WebSocket to the hub -- the link. A page that
 * wants another machine's conversation addresses it as `/d/<deviceId>/…`, the
 * hub hands it to that machine over its link, and the machine runs it through
 * its own routes as if a remote browser had asked.
 *
 * Only the hub ever opens a stream on a link. A member's own reach to other
 * machines goes out as ordinary HTTPS/WSS to the hub, so the link needs no
 * multiplexing in the other direction, no stream-number parity and no
 * fragmentation: one WebSocket message is one frame.
 */

export const FEDERATION_PROTOCOL_VERSION = 1;

/**
 * The Host a forwarded request carries on the machine that runs it.
 *
 * Reserved by RFC 6761, so nothing real ever sends it. Every "this machine
 * only" check in the server reads Host or Origin, and a forwarded request
 * built with this Host fails all of them, which is what makes it remote --
 * by construction, not by remembering to check a flag.
 */
export const FEDERATION_HOST = "federation.invalid";

export const FrameType = {
  Control: 1,
  Request: 2,
  Response: 3,
  SocketOpen: 4,
  SocketText: 5,
  SocketBinary: 6,
  SocketClose: 7,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export const FRAME_HEADER_BYTES = 5;
/**
 * One frame, at most. The largest single message measured over two weeks was
 * about 80 KB (`answers.changed`) and a remote terminal snapshot is capped at
 * 64 KiB, so this leaves two orders of magnitude and no need to fragment.
 */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** WebSocket close codes this feature adds. */
export const FederationClose = {
  /** The same process reconnected; the old link is simply replaced. */
  superseded: 4000,
  /** Another instance connected with this device's identity -- usually a copied data folder. */
  replaced: 4409,
  /** The device a page asked for is offline or unknown. */
  deviceUnavailable: 4501,
  /** A member could not reach the hub. */
  hubUnreachable: 4503,
} as const;

export type Frame = { type: FrameTypeValue; stream: number; payload: Uint8Array };

const FRAME_NAMES: Record<number, string> = {
  [FrameType.Control]: "control",
  [FrameType.Request]: "request",
  [FrameType.Response]: "response",
  [FrameType.SocketOpen]: "socket.open",
  [FrameType.SocketText]: "socket.text",
  [FrameType.SocketBinary]: "socket.binary",
  [FrameType.SocketClose]: "socket.close",
};

/** For the traffic ledger: `link.request`, `link.socket.binary`, … */
export function frameName(type: number): string {
  return `link.${FRAME_NAMES[type] ?? "unknown"}`;
}

const KNOWN_TYPES = new Set<number>(Object.values(FrameType));

export function encodeFrame(type: FrameTypeValue, stream: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!Number.isInteger(stream) || stream < 0 || stream > 0xffffffff) throw new Error("FEDERATION_STREAM_OUT_OF_RANGE");
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  frame[0] = type;
  new DataView(frame.buffer).setUint32(1, stream, false);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
}

/** Null for anything that is not a frame this version defines. */
export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.length < FRAME_HEADER_BYTES || data.length > MAX_FRAME_BYTES + FRAME_HEADER_BYTES) return null;
  const type = data[0]!;
  if (!KNOWN_TYPES.has(type)) return null;
  const stream = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(1, false);
  return { type: type as FrameTypeValue, stream, payload: data.subarray(FRAME_HEADER_BYTES) };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function decodeJson<T = unknown>(payload: Uint8Array): T | null {
  try { return JSON.parse(decoder.decode(payload)) as T; } catch { return null; }
}

/**
 * A request or response: a JSON head, then the body exactly as it was.
 *
 * The body is never base64'd into the JSON. With encryption on it is
 * ciphertext, and a third more bytes for every sealed answer is the opposite
 * of what the traffic work was for.
 */
export function encodeHeadBody(head: unknown, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const headBytes = encodeJson(head);
  const out = new Uint8Array(4 + headBytes.length + body.length);
  new DataView(out.buffer).setUint32(0, headBytes.length, false);
  out.set(headBytes, 4);
  out.set(body, 4 + headBytes.length);
  return out;
}

export function decodeHeadBody<T>(payload: Uint8Array): { head: T; body: Uint8Array } | null {
  if (payload.length < 4) return null;
  const headLength = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, false);
  if (headLength > payload.length - 4) return null;
  const head = decodeJson<T>(payload.subarray(4, 4 + headLength));
  if (head === null || typeof head !== "object") return null;
  return { head, body: payload.subarray(4 + headLength) };
}

export type RequestHead = { method: string; path: string; headers: Record<string, string> };
export type ResponseHead = { status: number; headers: Record<string, string> };

/**
 * The only headers that cross from one machine to another.
 *
 * Host, Origin, Referer, Cookie, Authorization and the page's token are
 * deliberately absent: the machine that runs a request builds those itself,
 * and a value copied from the original request is exactly how a remote
 * request would end up looking local.
 */
export const REQUEST_HEADERS: readonly string[] = ["content-type", "accept", "accept-encoding", "if-none-match"];
export const RESPONSE_HEADERS: readonly string[] = ["content-type", "content-encoding", "etag", "cache-control", "x-promptor-e2ee"];

export const RELAY_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function pickHeaders(headers: Record<string, unknown> | undefined | null, names: readonly string[]): Record<string, string> {
  const picked: Record<string, string> = {};
  if (!headers) return picked;
  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string" && value.length <= 8_192) picked[name] = value;
    else if (typeof value === "number") picked[name] = String(value);
  }
  return picked;
}

const PATH_CHARACTERS = /^\/api\/[A-Za-z0-9\-._~:@!$&'()*+,;=%/]*$/;
const MAX_RELAY_PATH = 4_096;

/**
 * The path a forwarded request may carry, or null.
 *
 * Only `/api/…`, so hooks, A2A and the federation link itself can never be
 * reached through a relay. No dot segments, no doubled or back slashes, and no
 * encoded slash, backslash or dot, so what is checked here is what the router
 * sees after decoding. `/api/federation…` is refused too: the admin routes
 * belong to the machine's own loopback page and nobody else.
 */
export function relayPath(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RELAY_PATH) return null;
  const queryAt = raw.indexOf("?");
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  const query = queryAt === -1 ? "" : raw.slice(queryAt + 1);
  if (!PATH_CHARACTERS.test(path)) return null;
  if (path.includes("//") || /%(?:2f|5c|2e)/i.test(path)) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (path === "/api/federation" || path.startsWith("/api/federation/")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\s#\u0000-\u001f\u007f]/.test(query)) return null;
  return queryAt === -1 ? path : `${path}?${query}`;
}

/** UUIDs, which is what a device id is; anything else in that URL segment is a mistake or a probe. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * A close code `ws` will accept for sending. 1005 and 1006 describe a close
 * that had no code; they can be observed but never sent, so a relay that
 * passes them on maps them to the nearest thing that can be.
 */
export function sendableCloseCode(code: number | undefined): number {
  if (typeof code !== "number" || !Number.isInteger(code)) return 1000;
  if ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999)) return code;
  return code === 1005 ? 1000 : 1011;
}

/** A WebSocket close reason is at most 123 bytes; longer ones make `close()` throw. */
export function sendableCloseReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason : reason instanceof Uint8Array ? decoder.decode(reason) : "";
  let out = text;
  while (encoder.encode(out).length > 123) out = out.slice(0, -1);
  return out;
}

export type DirectoryDevice = {
  id: string;
  name: string;
  online: boolean;
  /** Application version plus a build marker, so a mismatch can be pointed out. */
  version: string | null;
};

export type FederationMode = "off" | "hub" | "member";

/** What a page is told: which machines there are and which one it is talking to. */
export type FederationView = {
  mode: FederationMode;
  /** The machine serving this page, or null when federation is off. */
  selfId: string | null;
  /** Always true on the hub; on a member, whether its link is up right now. */
  hubReachable: boolean;
  /** Registration order, the hub first. Empty when federation is off. */
  devices: DirectoryDevice[];
};

export const FEDERATION_OFF_VIEW: FederationView = { mode: "off", selfId: null, hubReachable: false, devices: [] };
