/**
 * The shape of one encrypted message, and the decisions that keep it small.
 *
 * Measured composition on the tunnel is 25,607 messages over six days, most of
 * them under a kilobyte and 9,855 of them 39-byte keystrokes. At that size the
 * per-message overhead is the design: a scheme that sends a random nonce with
 * every frame would add 28 bytes where this adds 17, and on the keystroke
 * channel that is the difference between +44% and +72%.
 *
 *   [ 1 B flags ][ ciphertext ][ 16 B GCM tag ]
 *
 * Three things are deliberately *not* in the frame:
 *
 * - **The nonce**, because keys are derived per connection and per direction
 *   (TRAFFIC_OPTIMIZATION.md §5.4), so a counter is already unique under its
 *   own key and both ends can count.
 * - **The counter**, because WebSocket delivers in order and reliably. If the
 *   two sides ever disagree the GCM tag fails, which is the outcome carrying
 *   it would have produced anyway, one byte-count later.
 * - **The key id**, because a connection is bound to one key for its whole
 *   life. Rotation means a new handshake, so this belongs there and not on
 *   every frame.
 *
 * Each of those was written into the frame first and taken back out: together
 * they were six bytes on every message to restate what the connection already
 * knew.
 */

export const ENVELOPE_HEADER_BYTES = 1;
export const GCM_TAG_BYTES = 16;

/** What a frame costs beyond its payload: header plus tag. */
export const ENVELOPE_OVERHEAD_BYTES = ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES;

export const FLAG_COMPRESSED = 0x01;

/**
 * Below this, compression is not attempted at all.
 *
 * A 39-byte keystroke cannot be made smaller by deflate; trying costs CPU on
 * every frame of the busiest inbound channel and reliably produces something
 * larger. The threshold is where deflate's own framing stops dominating.
 */
export const COMPRESSION_MIN_BYTES = 256;

/** Compression is kept only when it earns both of these. */
export const COMPRESSION_MIN_SAVED_BYTES = 32;
export const COMPRESSION_MIN_SAVED_RATIO = 0.1;

/**
 * Whether a compressed candidate is worth sending instead of the original.
 *
 * Two conditions rather than one: a ratio alone keeps a 40-byte saving on a
 * large frame that is not worth the decompress, and an absolute alone keeps a
 * 33-byte saving on a 20 KB frame that is noise.
 */
export function shouldSendCompressed(plainBytes: number, compressedBytes: number): boolean {
  if (plainBytes < COMPRESSION_MIN_BYTES) return false;
  const saved = plainBytes - compressedBytes;
  return saved >= COMPRESSION_MIN_SAVED_BYTES && saved >= plainBytes * COMPRESSION_MIN_SAVED_RATIO;
}

export type EnvelopeHeader = { compressed: boolean };

export function encodeEnvelopeHeader(header: EnvelopeHeader): Uint8Array {
  return new Uint8Array([header.compressed ? FLAG_COMPRESSED : 0]);
}

/** Null for anything too short to be a frame, or carrying a flag this version does not define. */
export function decodeEnvelopeHeader(frame: Uint8Array): EnvelopeHeader | null {
  if (frame.length < ENVELOPE_HEADER_BYTES + GCM_TAG_BYTES) return null;
  const flags = frame[0]!;
  // An unknown flag means a newer sender. Guessing at its framing would be
  // worse than refusing: the tag would fail anyway, later and less clearly.
  if ((flags & ~FLAG_COMPRESSED) !== 0) return null;
  return { compressed: (flags & FLAG_COMPRESSED) !== 0 };
}

/**
 * The 96-bit AES-GCM nonce for a counter.
 *
 * Zero-padded rather than random: the key is already unique to this connection
 * and direction, so the counter alone cannot repeat under it. AES-GCM's one
 * hard requirement is that a nonce never repeats under a key, which makes the
 * counter's monotonicity a correctness property, not an optimisation.
 */
export function nonceForCounter(counter: number): Uint8Array {
  if (!Number.isInteger(counter) || counter < 0 || counter > 0xffffffff) {
    throw new Error("E2EE_COUNTER_OUT_OF_RANGE");
  }
  const nonce = new Uint8Array(12);
  nonce[8] = (counter >>> 24) & 0xff;
  nonce[9] = (counter >>> 16) & 0xff;
  nonce[10] = (counter >>> 8) & 0xff;
  nonce[11] = counter & 0xff;
  return nonce;
}

/**
 * The counter a side moves to after using one, or null when it is spent.
 *
 * AES-GCM's one hard requirement is that a nonce never repeats under a key, so
 * the counter must not wrap. Null means this connection has to be replaced
 * rather than allowed to reuse a nonce -- four billion frames away on a
 * channel measured at 25,607 messages in six days, but the check costs nothing
 * and the alternative is silent.
 */
export function nextCounter(counter: number): number | null {
  return counter >= 0xffffffff ? null : counter + 1;
}
