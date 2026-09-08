import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeBase64, encodeBase64 } from "../shared/e2ee-keys.js";
import {
  HANDSHAKE_CHALLENGE,
  HANDSHAKE_PROOF,
  HANDSHAKE_READY,
  KEY_CHANGED_CLOSE_CODE,
  challengeIsWellFormed,
  handshakeAad,
} from "../shared/e2ee-handshake.js";
import { ClientWire, connectionWireKeys } from "../client/e2ee-wire.js";
import { createApp, type PromptorApp } from "./app.js";
import { deriveMasterKey, subKey } from "./e2ee-key-material.js";
import { open, seal } from "./e2ee-session.js";

const PASSPHRASE = "一句只有我知道的话 42";
const REMOTE_HOST = "promptor.example.com";

describe("proving both ends hold the same key", () => {
  let app: PromptorApp;
  let root: string;
  let address: string;
  let salt: string;
  let iterations: number;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-handshake-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    address = await app.listen({ host: "127.0.0.1", port: 0 });
    const tabId = (await app.promptor.storage.createTab("加密")).id;
    const created = await app.inject({
      method: "POST",
      url: `/api/tabs/${tabId}/session`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
      payload: { provider: "e2ee", workingDirectory: PASSPHRASE } as never,
    });
    expect(created.statusCode).toBe(200);
    const session = (await app.promptor.storage.getTabMeta(tabId)).session;
    salt = session.e2ee!.salt;
    iterations = session.e2ee!.iterations;
  });

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => new Promise<void>((resolve) => {
      socket.on("close", () => resolve());
      socket.close();
      setTimeout(resolve, 200);
    })));
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  /** A remote page, doing exactly what the browser will have to do. */
  const connect = async (host?: string) => {
    const url = `${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`;
    const socket = new WebSocket(url, host ? { headers: { host } } : undefined);
    sockets.push(socket);
    const messages: any[] = [];
    const frames: Buffer[] = [];
    let closed: { code: number } | null = null;
    // Deliberately the browser's own module, run against the real server: the
    // interop that can break here is between two crypto libraries, and a test
    // that used the server's implementation for both ends would not see it.
    let wire: ClientWire | null = null;
    socket.on("message", (raw: Buffer) => {
      frames.push(Buffer.from(raw));
      if (!wire) { messages.push(JSON.parse(raw.toString())); return; }
      void wire.open(new Uint8Array(raw)).then((text) => { if (text !== null) messages.push(JSON.parse(text)); });
    });
    socket.on("close", (code: number) => { closed = { code }; });
    await new Promise<void>((resolve, reject) => { socket.on("open", () => resolve()); socket.on("error", reject); });
    const settle = async (done: () => boolean, ms = 3_000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline && !done()) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return {
      socket,
      messages,
      frames,
      settle,
      isClosed: () => closed !== null,
      closeCode: () => closed?.code ?? null,
      /** Everything from here is sealed, in both directions. */
      useWire: (next: ClientWire) => { wire = next; },
      send: (message: unknown) => {
        if (wire) wire.send(JSON.stringify(message));
        else socket.send(JSON.stringify(message));
      },
    };
  };

  /** The data-plane keys a page derives once the far end says the handshake passed. */
  const dataPlane = async (socket: WebSocket, challenge: any, passphrase: string) => {
    const master = await deriveMasterKey(passphrase, Buffer.from(decodeBase64(salt)), iterations);
    const hkdf = await crypto.subtle.importKey("raw", new Uint8Array(master), "HKDF", false, ["deriveKey"]);
    const keys = await connectionWireKeys(hkdf, decodeBase64(challenge.connectionSalt));
    return new ClientWire(socket as never, keys.toClient, keys.toServer);
  };

  const answer = async (challenge: any, passphrase: string) => {
    const master = await deriveMasterKey(passphrase, Buffer.from(decodeBase64(salt)), iterations);
    const auth = subKey(master, "auth");
    const nonce = new Uint8Array(12);
    const opened = open(auth, nonce, decodeBase64(challenge.serverProof), handshakeAad("server", challenge.fingerprint));
    const proof = opened
      ? encodeBase64(new Uint8Array(seal(auth, nonce, opened, handshakeAad("client", challenge.fingerprint))))
      : null;
    return { opened, proof };
  };

  it("greets a remote connection with a challenge and opens the stream on its answer", async () => {
    const peer = await connect(REMOTE_HOST);
    await peer.settle(() => peer.messages.length >= 1);
    const challenge = peer.messages[0];
    expect(challengeIsWellFormed(challenge)).toBe(true);
    expect(challenge.type).toBe(HANDSHAKE_CHALLENGE);

    // The server proves itself first: a client that cannot check the far end
    // would take a hostile relay's noise for a server having trouble.
    const { opened, proof } = await answer(challenge, PASSPHRASE);
    expect(opened, "the server's own proof opens under the right key").not.toBeNull();
    expect(Buffer.from(opened!).equals(Buffer.from(decodeBase64(challenge.challenge)))).toBe(true);

    peer.socket.send(JSON.stringify({ type: HANDSHAKE_PROOF, proof }));
    await peer.settle(() => peer.messages.some((message) => message.type === HANDSHAKE_READY));
    expect(peer.messages.some((message) => message.type === HANDSHAKE_READY)).toBe(true);

    // And only now is the connection allowed to ask for anything -- sealed,
    // because the ready message is the last readable frame either way.
    peer.useWire(await dataPlane(peer.socket, challenge, PASSPHRASE));
    peer.send({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {} });
    await peer.settle(() => peer.messages.some((message) => message.type === "index.changed"));
    expect(peer.messages.some((message) => message.type === "index.changed")).toBe(true);

    // The name of a conversation is the cheapest thing to look for, and the
    // reason this step exists: before it, every terminal frame and keystroke
    // crossed the tunnel as readable JSON.
    const index = peer.messages.find((message) => message.type === "index.changed");
    expect(JSON.stringify(index)).toContain("加密");
    const readable = peer.frames.map((frame) => frame.toString("utf8")).join("");
    expect(readable, "nothing on the wire says what any of it is").not.toContain("加密");
    expect(readable).not.toContain("index.changed");
  });

  it("hangs up on the devices paired to a key that has just been replaced", async () => {
    const peer = await connect(REMOTE_HOST);
    await peer.settle(() => peer.messages.length >= 1);
    const challenge = peer.messages[0];
    const { proof } = await answer(challenge, PASSPHRASE);
    peer.socket.send(JSON.stringify({ type: HANDSHAKE_PROOF, proof }));
    await peer.settle(() => peer.messages.some((message) => message.type === HANDSHAKE_READY));
    peer.useWire(await dataPlane(peer.socket, challenge, PASSPHRASE));

    // This connection's keys came from the old master and would go on working
    // for as long as it stayed open, which is the wrong answer to "I rotated
    // the key". Setting a new one has to reach it.
    const tabId = (await app.promptor.storage.listTabMeta()).find((tab) => tab.session.provider === "e2ee")!.id;
    const rotated = await app.inject({
      method: "POST",
      url: `/api/tabs/${tabId}/session`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
      payload: { provider: "e2ee", workingDirectory: "换了一句新的口令" } as never,
    });
    expect(rotated.statusCode).toBe(200);
    await peer.settle(() => peer.isClosed());
    expect(peer.isClosed()).toBe(true);
    expect(peer.closeCode(), "and says why, so the page asks bootstrap instead of retrying blind").toBe(KEY_CHANGED_CLOSE_CODE);
  });

  it("leaves loopback connected when the key changes, because that is where it changed", async () => {
    const peer = await connect();
    peer.send({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {} });
    await peer.settle(() => peer.messages.some((message) => message.type === "index.changed"));
    const tabId = (await app.promptor.storage.listTabMeta()).find((tab) => tab.session.provider === "e2ee")!.id;
    await app.inject({
      method: "POST",
      url: `/api/tabs/${tabId}/session/close`,
      headers: { "x-codex-promptor-token": app.promptor.token, host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" },
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(peer.isClosed()).toBe(false);

    // And with the switch closed, a fresh remote connection is not challenged.
    const after = await connect(REMOTE_HOST);
    after.send({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {} });
    await after.settle(() => after.messages.some((message) => message.type === "index.changed"));
    expect(after.messages.some((message) => message.type === HANDSHAKE_CHALLENGE)).toBe(false);
  });

  it("closes on a wrong key rather than letting it look like a slow terminal", async () => {
    const peer = await connect(REMOTE_HOST);
    await peer.settle(() => peer.messages.length >= 1);
    const { opened, proof } = await answer(peer.messages[0], "口令输错了");
    // The reader learns immediately, from the server's own proof failing to
    // open, before anything of theirs has been sent anywhere.
    expect(opened).toBeNull();
    expect(proof).toBeNull();

    peer.socket.send(JSON.stringify({ type: HANDSHAKE_PROOF, proof: encodeBase64(new Uint8Array(32)) }));
    await peer.settle(() => peer.isClosed());
    expect(peer.isClosed()).toBe(true);
  });

  it("ignores everything else until the answer arrives", async () => {
    const peer = await connect(REMOTE_HOST);
    await peer.settle(() => peer.messages.length >= 1);
    const before = peer.messages.length;

    peer.socket.send(JSON.stringify({ type: "subscribe", tabIds: [], index: true, snapshots: true, terminals: {} }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(peer.messages.length, "an unproved connection is answered with nothing").toBe(before);
  });

  it("asks nothing of loopback, which is where the passphrase was typed", async () => {
    const peer = await connect();
    peer.socket.send(JSON.stringify({ type: "subscribe", tabIds: [], index: true, snapshots: false, terminals: {} }));
    await peer.settle(() => peer.messages.some((message) => message.type === "index.changed"));
    expect(peer.messages.some((message) => message.type === HANDSHAKE_CHALLENGE)).toBe(false);
    expect(peer.messages.some((message) => message.type === "index.changed")).toBe(true);
  });

  it("tells a page that encryption is on, and which key it wants", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { "x-codex-promptor-token": app.promptor.token, host: REMOTE_HOST },
    });
    const data = response.json().data;
    expect(data.e2ee.required).toBe(true);
    expect(data.e2ee.fingerprint).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    // A page cannot be asked for a key it does not know it needs, and the
    // passphrase is still not in the answer.
    expect(response.body).not.toContain(PASSPHRASE);
  });
});
