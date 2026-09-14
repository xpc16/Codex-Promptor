import { describe, expect, it } from "vitest";
import { loadCodec } from "../client/e2ee-codec.js";
import { ClientWire, DICTIONARY_FAILED_CLOSE_CODE, connectionWireKeys, type WireCompression } from "../client/e2ee-wire.js";
import { DICTIONARY_D1 } from "../shared/e2ee-dictionary.js";
import { ENVELOPE_OVERHEAD_BYTES, FLAG_COMPRESSED, FLAG_DICTIONARY } from "../shared/e2ee-envelope.js";
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
  const closes: number[] = [];
  return {
    frames,
    closes,
    readyState: 1,
    send: (data: ArrayBuffer | string) => { frames.push(new Uint8Array(data as ArrayBuffer)); },
    close: (code?: number) => { closes.push(code ?? 1005); },
  };
};

const browser = async (socket: ReturnType<typeof recorder>, compression: Partial<WireCompression> = {}) => {
  const hkdf = await crypto.subtle.importKey("raw", new Uint8Array(MASTER), "HKDF", false, ["deriveKey"]);
  const keys = await connectionWireKeys(hkdf, SALT);
  return new ClientWire(socket, keys.toClient, keys.toServer, compression);
};

const server = (dictionary: Buffer | null = null) => {
  const keys = connectionKeys(MASTER, SALT);
  return new ServerWire(keys.toClient, keys.toServer, dictionary);
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

/**
 * The same two implementations with the dictionary between them. Here the
 * codecs differ too -- zlib on the server, fflate in the browser -- and a
 * dictionary is exactly the kind of option two deflate implementations could
 * agree to support and still disagree about.
 */
describe("a sealed WebSocket with the preset dictionary", () => {
  const DICT = Buffer.from(DICTIONARY_D1);
  const style = { fg: "default", bg: "default", flags: [] };
  const delta = JSON.stringify({
    type: "terminal.screen", tabId: "b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b", generation: "7e8f9a0b-1c2d-4e3f-a4b5-c6d7e8f9a0b1",
    streamId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", sequence: 4821, revision: 91827, full: false,
    cols: 120, totalRows: 6000, viewportTop: 5980, viewportRows: 20, alternateScreen: false, sizeEpoch: 3,
    inputModes: { applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: true, mouseTracking: "none", sendFocus: false },
    cursor: { row: 19, col: 2, visible: true },
    rows: [{ row: 12, clearToEnd: true, runs: [{ text: "  1. Compiling src/server/app.ts (1237 lines)", style }] }],
    scroll: { top: 0, bottom: 19, lines: 1 },
  });

  it("carries a delta the server deflated against it, in fewer than half the bytes", async () => {
    const codec = await loadCodec();
    expect(codec, "fflate loads in Node the way it will in the browser").not.toBeNull();
    const plain = server().seal(delta)!;
    const framed = server(DICT).seal(delta)!;
    expect(framed[0]! & FLAG_DICTIONARY).toBe(FLAG_DICTIONARY);
    expect(framed[0]! & FLAG_COMPRESSED).toBe(FLAG_COMPRESSED);
    expect(framed.length).toBeLessThan(plain.length / 2);

    const socket = recorder();
    const wire = await browser(socket, { codec, dictionary: DICTIONARY_D1 });
    expect(await wire.open(new Uint8Array(framed))).toBe(delta);
  });

  it("carries a subscribe the browser deflated against it, the other way", async () => {
    const codec = await loadCodec();
    const socket = recorder();
    const wire = await browser(socket, { codec, dictionary: DICTIONARY_D1 });
    const subscribe = JSON.stringify({ type: "subscribe", terminalProtocolVersion: 2, tabIds: ["b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b"], snapshots: true, details: true, terminals: { "b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b": { mode: "projection", viewportRows: 20, fps: 2, generation: null, revision: null, sizeEpoch: null } } });
    wire.send(subscribe);
    await settled();
    expect(socket.frames[0]![0]! & FLAG_DICTIONARY).toBe(FLAG_DICTIONARY);
    expect(server(DICT).open(socket.frames[0]!)).toBe(subscribe);
  });

  it("still lowers the floor for the small frames, which is most of them", async () => {
    // A 126-byte terminal.state never cleared the plain 256-byte floor; with
    // the dictionary it is worth compressing.
    const state = '{"type":"terminal.state","tabId":"b3f7c2a1-4d5e-4f60-8a9b-0c1d2e3f4a5b","sequence":812,"state":"running","cols":132,"rows":34}';
    expect(server().seal(state)![0]! & FLAG_COMPRESSED).toBe(0);
    const framed = server(DICT).seal(state)!;
    expect(framed[0]! & FLAG_DICTIONARY).toBe(FLAG_DICTIONARY);
    expect(framed.length).toBeLessThan(Buffer.byteLength(state) + ENVELOPE_OVERHEAD_BYTES);
  });

  it("gives nothing, and hangs up, when a dictionary frame reaches a browser without one", async () => {
    // The negotiation said none; a frame that claims one is either a bug or
    // not from this server. Silence would look like a slow terminal, so the
    // socket is closed with a code the gate recognises.
    const codec = await loadCodec();
    const socket = recorder();
    const wire = await browser(socket, { codec, dictionary: null });
    expect(await wire.open(new Uint8Array(server(DICT).seal(delta)!))).toBeNull();
    expect(socket.closes).toEqual([DICTIONARY_FAILED_CLOSE_CODE]);
  });

  it("gives nothing to a server that settled on none", async () => {
    const codec = await loadCodec();
    const socket = recorder();
    const wire = await browser(socket, { codec, dictionary: DICTIONARY_D1 });
    wire.send(delta);
    await settled();
    expect(server().open(socket.frames[0]!)).toBeNull();
  });

  it("interoperates without a dictionary when only the codec changed", async () => {
    // A page whose codec loaded but whose server offered nothing: fflate on
    // one end, zlib on the other, no dictionary on either.
    const codec = await loadCodec();
    const socket = recorder();
    const wire = await browser(socket, { codec });
    expect(await wire.open(new Uint8Array(server().seal(delta)!))).toBe(delta);
    wire.send(delta);
    await settled();
    expect(socket.frames[0]![0]! & FLAG_DICTIONARY).toBe(0);
    expect(server().open(socket.frames[0]!)).toBe(delta);
  });
});
