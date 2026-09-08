import {
  COMPRESSION_MIN_BYTES,
  ENVELOPE_HEADER_BYTES,
  GCM_TAG_BYTES,
  decodeEnvelopeHeader,
  encodeEnvelopeHeader,
  nextCounter,
  nonceForCounter,
  shouldSendCompressed,
} from "../shared/e2ee-envelope.js";
import { CONNECTION_LABELS } from "../shared/e2ee-keys.js";

/**
 * The browser's half of one encrypted WebSocket.
 *
 * The awkward part here, and the reason this is a class rather than two
 * functions, is that WebCrypto is asynchronous while a WebSocket is ordered.
 * A counter-based nonce only works if both ends agree on which frame is which,
 * so both directions run through a promise chain: frames are sealed and opened
 * in the order they were handed over, whatever order the crypto finishes in.
 */

type WireSocket = {
  send(data: ArrayBuffer | string): void;
  readyState?: number;
  close?(code?: number, reason?: string): void;
};

/** Matches the server's `connectionKeys`: HKDF over the master, salted per connection. */
export async function connectionWireKeys(master: CryptoKey, connectionSalt: Uint8Array): Promise<{ toClient: CryptoKey; toServer: CryptoKey }> {
  const derive = (label: string) => crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: connectionSalt as BufferSource, info: new TextEncoder().encode(label) },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const [toClient, toServer] = await Promise.all([derive(CONNECTION_LABELS.toClient), derive(CONNECTION_LABELS.toServer)]);
  return { toClient, toServer };
}

/**
 * Deflate, when the browser has it and the frame is big enough to gain.
 *
 * Absent on nothing this app targets, but the flag byte already says whether a
 * frame was compressed, so a browser without `CompressionStream` simply never
 * sets it and stays interoperable. A 39-byte keystroke never reaches here.
 */
async function deflate(raw: Uint8Array): Promise<Uint8Array | null> {
  if (raw.length < COMPRESSION_MIN_BYTES || typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([raw as BufferSource]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(raw: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([raw as BufferSource]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A frame arrives as an ArrayBuffer when `binaryType` says so, and as a Blob when nobody set it. */
async function frameBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  return null;
}

export class ClientWire {
  private outCounter = 0;
  private inCounter = 0;
  private outTail: Promise<unknown> = Promise.resolve();
  private inTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly socket: WireSocket,
    private readonly toClient: CryptoKey,
    private readonly toServer: CryptoKey,
  ) {}

  /**
   * Queued rather than sent, because sealing has to finish first and the
   * caller is a keystroke handler that cannot wait. Order is what the counter
   * depends on, so the chain is the point, not an optimisation.
   */
  send(text: string): void {
    this.outTail = this.outTail.then(() => this.sealAndSend(text)).catch(() => undefined);
  }

  private async sealAndSend(text: string): Promise<void> {
    const counter = this.outCounter;
    const next = nextCounter(counter);
    // Four billion frames on a channel measured at 25,607 in six days. The
    // check costs nothing, and reusing a nonce is the one thing AES-GCM cannot
    // survive, so the connection goes rather than the guarantee.
    if (next === null) { this.socket.close?.(4002, "e2ee_counter_exhausted"); return; }
    const raw = new TextEncoder().encode(text);
    const candidate = await deflate(raw);
    const compressed = candidate !== null && shouldSendCompressed(raw.length, candidate.length);
    const header = encodeEnvelopeHeader({ compressed });
    const sealed = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceForCounter(counter) as BufferSource, additionalData: header as BufferSource, tagLength: GCM_TAG_BYTES * 8 },
      this.toServer,
      (compressed ? candidate! : raw) as BufferSource,
    ));
    const frame = new Uint8Array(header.length + sealed.length);
    frame.set(header);
    frame.set(sealed, header.length);
    if (this.socket.readyState !== undefined && this.socket.readyState !== 1) return;
    // Counted only once it is actually gone: a frame the socket refused was
    // never seen by the far end, and consuming a counter for it would put
    // every frame after it a step out of step.
    this.socket.send(frame.buffer as ArrayBuffer);
    this.outCounter = next;
  }

  /** Null for a frame that did not open; see the note on the server's `open`. */
  open(data: unknown): Promise<string | null> {
    const result = this.inTail.then(() => this.decode(data));
    this.inTail = result.catch(() => null);
    return result;
  }

  private async decode(data: unknown): Promise<string | null> {
    const frame = await frameBytes(data);
    const header = frame && decodeEnvelopeHeader(frame);
    if (!frame || !header) return null;
    const next = nextCounter(this.inCounter);
    if (next === null) return null;
    let opened: Uint8Array;
    try {
      opened = new Uint8Array(await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceForCounter(this.inCounter) as BufferSource, additionalData: frame.subarray(0, ENVELOPE_HEADER_BYTES) as BufferSource, tagLength: GCM_TAG_BYTES * 8 },
        this.toClient,
        frame.subarray(ENVELOPE_HEADER_BYTES) as BufferSource,
      ));
    } catch {
      return null;
    }
    this.inCounter = next;
    if (!header.compressed) return new TextDecoder().decode(opened);
    const plain = await inflate(opened);
    return plain ? new TextDecoder().decode(plain) : null;
  }
}
