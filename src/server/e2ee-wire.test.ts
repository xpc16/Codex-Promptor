import { describe, expect, it } from "vitest";
import { ClientWire, connectionWireKeys } from "../client/e2ee-wire.js";
import { ENVELOPE_OVERHEAD_BYTES } from "../shared/e2ee-envelope.js";
import { connectionKeys } from "./e2ee-session.js";
import { ServerWire } from "./e2ee-wire.js";

/**
 * The two implementations against each other, because that is where this can
 * break: Node's crypto seals and WebCrypto opens, and nothing about either
 * module on its own would notice if they disagreed about the nonce, the flag
 * byte or which key goes which way.
 */

const MASTER = Buffer.alloc(32, 3);
const SALT = new Uint8Array(16).fill(9);

/** A socket that only remembers, so a frame can be inspected before it goes anywhere. */
const recorder = () => {
  const frames: Uint8Array[] = [];
  return { frames, readyState: 1, send: (data: ArrayBuffer | string) => { frames.push(new Uint8Array(data as ArrayBuffer)); } };
};

const browser = async (socket: ReturnType<typeof recorder>) => {
  const hkdf = await crypto.subtle.importKey("raw", new Uint8Array(MASTER), "HKDF", false, ["deriveKey"]);
  const keys = await connectionWireKeys(hkdf, SALT);
  return new ClientWire(socket, keys.toClient, keys.toServer);
};

const server = () => {
  const keys = connectionKeys(MASTER, SALT);
  return new ServerWire(keys.toClient, keys.toServer);
};

/** The client seals on a promise chain, so a test has to let it finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 30));

describe("a sealed WebSocket, in both directions", () => {
  it("carries what the server sent to a browser that only holds the key", async () => {
    const socket = recorder();
    const wire = await browser(socket);
    const frame = server().seal('{"type":"index.changed"}');
    expect(frame).not.toBeNull();
    expect(await wire.open(new Uint8Array(frame!))).toBe('{"type":"index.changed"}');
  });

  it("carries a keystroke the other way", async () => {
    const socket = recorder();
    const wire = await browser(socket);
    wire.send('{"type":"ti","d":"a"}');
    await settled();
    expect(server().open(socket.frames[0]!)).toBe('{"type":"ti","d":"a"}');
  });

  it("costs seventeen bytes on a frame too small to compress", async () => {
    // The measured composition is 9,855 keystrokes in six days. At that size
    // the per-frame overhead *is* the design: sending a nonce with each one
    // would make it 28 bytes rather than 17.
    const socket = recorder();
    const wire = await browser(socket);
    const keystroke = '{"type":"ti","s":1,"d":"a"}';
    wire.send(keystroke);
    await settled();
    expect(socket.frames[0]!.length - Buffer.byteLength(keystroke, "utf8")).toBe(ENVELOPE_OVERHEAD_BYTES);
  });

  it("compresses before sealing, so a repetitive screen still shrinks", async () => {
    // Reversing this order is the one mistake with a measured cost: ciphertext
    // does not compress, and 8.31 MB on the tunnel would become roughly 19 MB.
    const screen = JSON.stringify({ type: "terminal.screen", rows: new Array(60).fill("PS D:\\Claude_convers> ") });
    const frame = server().seal(screen);
    expect(frame!.length).toBeLessThan(Buffer.byteLength(screen, "utf8") / 2);
    const socket = recorder();
    expect(await (await browser(socket)).open(new Uint8Array(frame!))).toBe(screen);
  });

  it("gives nothing to a connection that derived a different key", async () => {
    const strangerKeys = connectionKeys(Buffer.alloc(32, 4), SALT);
    const stranger = new ServerWire(strangerKeys.toClient, strangerKeys.toServer);
    const socket = recorder();
    expect(await (await browser(socket)).open(new Uint8Array(stranger.seal("{}")!))).toBeNull();
  });

  it("will not let a frame be replayed back the way it came", async () => {
    // Each direction has its own key, which is also what lets both ends count
    // from zero without ever colliding on a nonce.
    const keys = connectionKeys(MASTER, SALT);
    expect(keys.toClient.equals(keys.toServer)).toBe(false);
    const echo = new ServerWire(keys.toServer, keys.toClient);
    const socket = recorder();
    expect(await (await browser(socket)).open(new Uint8Array(echo.seal('{"a":1}')!))).toBeNull();
  });

  it("refuses a frame that arrived out of order, because the counter is the nonce", async () => {
    // Two ends counting for themselves is what keeps the nonce off the wire.
    // WebSocket is ordered and reliable, so this is the failure that says
    // something is wrong -- not a case to recover from.
    const sender = server();
    const first = sender.seal('{"n":1}')!;
    const second = sender.seal('{"n":2}')!;
    const socket = recorder();
    const wire = await browser(socket);
    expect(await wire.open(new Uint8Array(second))).toBeNull();
    expect(await wire.open(new Uint8Array(first)), "and the counter did not move on the failure").toBe('{"n":1}');
    expect(await wire.open(new Uint8Array(second))).toBe('{"n":2}');
  });

  it("keeps its own order when several frames are sealed at once", async () => {
    // Sealing is asynchronous in a browser while a WebSocket is not, so the
    // queue is a correctness property: a counter that got ahead of the frame
    // it belongs to would break every frame after it.
    const socket = recorder();
    const wire = await browser(socket);
    for (const n of [1, 2, 3, 4]) wire.send(JSON.stringify({ n }));
    await settled();
    const reader = server();
    expect(socket.frames.map((frame) => reader.open(frame))).toEqual([
      '{"n":1}', '{"n":2}', '{"n":3}', '{"n":4}',
    ]);
  });
});
