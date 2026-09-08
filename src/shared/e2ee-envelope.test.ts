import { describe, expect, it } from "vitest";
import {
  COMPRESSION_MIN_BYTES,
  ENVELOPE_OVERHEAD_BYTES,
  nextCounter,
  decodeEnvelopeHeader,
  encodeEnvelopeHeader,
  nonceForCounter,
  shouldSendCompressed,
} from "./e2ee-envelope.js";

const framed = (header: Uint8Array, payload = 20) =>
  new Uint8Array([...header, ...new Uint8Array(payload)]);

describe("what a frame costs", () => {
  it("is seventeen bytes, because the nonce is not sent", () => {
    // The whole point of deriving keys per connection and direction: at 39
    // bytes a keystroke, sending a random nonce would be 28 bytes of overhead
    // instead of 17.
    expect(ENVELOPE_OVERHEAD_BYTES).toBe(17);
  });
});

describe("the envelope header", () => {
  it("round-trips the one thing it carries", () => {
    for (const compressed of [true, false]) {
      expect(decodeEnvelopeHeader(framed(encodeEnvelopeHeader({ compressed })))).toEqual({ compressed });
    }
  });

  it("refuses a frame too short to hold a tag", () => {
    expect(decodeEnvelopeHeader(new Uint8Array(ENVELOPE_OVERHEAD_BYTES - 1))).toBeNull();
    expect(decodeEnvelopeHeader(new Uint8Array(0))).toBeNull();
  });

  it("refuses a flag this version does not define", () => {
    // A newer sender. Guessing at its framing would fail on the tag anyway,
    // later and less clearly than saying so here.
    expect(decodeEnvelopeHeader(framed(new Uint8Array([0x02])))).toBeNull();
  });
});

describe("the nonce for a counter", () => {
  it("is the counter, zero padded", () => {
    expect([...nonceForCounter(0)]).toEqual(new Array(12).fill(0));
    expect([...nonceForCounter(1)].slice(8)).toEqual([0, 0, 0, 1]);
    expect([...nonceForCounter(0xffffffff)].slice(8)).toEqual([255, 255, 255, 255]);
  });

  it("never repeats within a counter's range", () => {
    // AES-GCM's one hard requirement. The key is already unique per connection
    // and direction, so the counter alone carries this.
    const seen = new Set<string>();
    for (const counter of [0, 1, 2, 255, 256, 65535, 65536, 0xffffffff]) seen.add(String(nonceForCounter(counter)));
    expect(seen.size).toBe(8);
  });

  it("refuses a counter that cannot be encoded", () => {
    expect(() => nonceForCounter(0x1_0000_0000)).toThrow("E2EE_COUNTER_OUT_OF_RANGE");
    expect(() => nonceForCounter(-1)).toThrow("E2EE_COUNTER_OUT_OF_RANGE");
    expect(() => nonceForCounter(1.5)).toThrow("E2EE_COUNTER_OUT_OF_RANGE");
  });
});

describe("advancing the counter", () => {
  it("moves to the next one", () => {
    expect(nextCounter(0)).toBe(1);
    expect(nextCounter(0xfffffffe)).toBe(0xffffffff);
  });

  it("says the connection is spent rather than reusing a nonce", () => {
    // Wrapping would repeat a nonce under a key, which is the one thing
    // AES-GCM cannot survive. Four billion frames away, and silent if unchecked.
    expect(nextCounter(0xffffffff)).toBeNull();
  });
});

describe("whether to send the compressed candidate", () => {
  it("does not compress what is too small to gain", () => {
    // The 39-byte keystroke channel: 9,855 messages over six days that deflate
    // can only make larger.
    expect(shouldSendCompressed(39, 20)).toBe(false);
    expect(shouldSendCompressed(COMPRESSION_MIN_BYTES - 1, 10)).toBe(false);
  });

  it("keeps a saving that is both large enough and worth the decompress", () => {
    expect(shouldSendCompressed(1000, 500)).toBe(true);
  });

  it("drops a saving that is only a good ratio of nothing much", () => {
    expect(shouldSendCompressed(300, 275)).toBe(false);
  });

  it("drops a large absolute saving that is noise at that size", () => {
    expect(shouldSendCompressed(20000, 19960)).toBe(false);
  });

  it("never keeps a candidate that grew", () => {
    expect(shouldSendCompressed(1000, 1200)).toBe(false);
  });
});
