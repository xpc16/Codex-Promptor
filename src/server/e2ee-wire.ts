import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  COMPRESSION_MIN_BYTES,
  ENVELOPE_HEADER_BYTES,
  decodeEnvelopeHeader,
  encodeEnvelopeHeader,
  nextCounter,
  nonceForCounter,
  shouldSendCompressed,
} from "../shared/e2ee-envelope.js";
import { open as openSealed, seal as sealPlain } from "./e2ee-session.js";

/**
 * The server's half of one encrypted WebSocket.
 *
 * Everything that makes the frame small lives here rather than in the frame:
 * the keys belong to this connection and this direction, so the nonce is a
 * counter each side keeps for itself, and the header is one byte saying
 * whether the payload was deflated. Seventeen bytes per message, against
 * 25,607 messages in the six measured days.
 *
 * Compression happens before the seal and never after. Ciphertext does not
 * compress, so the other order would spend CPU to turn 8.31 MB on the tunnel
 * into roughly 19 MB -- worse than sending it in the clear. The same reason is
 * why an encrypted frame is handed to `ws` with `compress: false`.
 */

const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

export class ServerWire {
  private outCounter = 0;
  private inCounter = 0;

  constructor(private readonly toClient: Buffer, private readonly toServer: Buffer) {}

  /**
   * Null when this connection's counter is spent, which is the one condition
   * the caller must not paper over: reusing a nonce under a key is the single
   * thing AES-GCM cannot survive, so the connection is replaced instead.
   */
  seal(text: string): Buffer | null {
    const counter = this.outCounter;
    const next = nextCounter(counter);
    if (next === null) return null;
    const raw = Buffer.from(text, "utf8");
    const candidate = raw.length >= COMPRESSION_MIN_BYTES ? deflateRawSync(raw) : null;
    const compressed = candidate !== null && shouldSendCompressed(raw.length, candidate.length);
    const header = encodeEnvelopeHeader({ compressed });
    const frame = Buffer.concat([
      header,
      sealPlain(this.toClient, nonceForCounter(counter), compressed ? candidate! : raw, header),
    ]);
    this.outCounter = next;
    return frame;
  }

  /**
   * Null for a frame that did not open, and the counter deliberately does not
   * move when that happens.
   *
   * A page that has sent its proof but not yet seen the answer can still put a
   * plaintext keystroke on the wire; that frame is meant to be dropped, and
   * dropping it must not cost the counter, or every frame after it would fail
   * too. WebSocket is ordered and reliable, so the only frames that land here
   * are ones from that window or ones nobody holding the key could have sent.
   */
  open(frame: Uint8Array): string | null {
    const header = decodeEnvelopeHeader(frame);
    if (!header) return null;
    const next = nextCounter(this.inCounter);
    if (next === null) return null;
    const opened = openSealed(
      this.toServer,
      nonceForCounter(this.inCounter),
      frame.subarray(ENVELOPE_HEADER_BYTES),
      frame.subarray(0, ENVELOPE_HEADER_BYTES),
    );
    if (!opened) return null;
    this.inCounter = next;
    if (!header.compressed) return opened.toString("utf8");
    try {
      // Bounded, because the inflated length is claimed by whoever sent it.
      // The tag has already proved they hold the key, so this guards against a
      // bug on either end, not against a stranger.
      return inflateRawSync(opened, { maxOutputLength: MAX_INFLATED_BYTES }).toString("utf8");
    } catch {
      return null;
    }
  }
}
