import { describe, expect, it } from "vitest";
import {
  FRAME_HEADER_BYTES,
  FrameType,
  bodyIsIncompressible,
  decodeFrame,
  decodeHeadBody,
  encodeFrame,
  encodeHeadBody,
  isDeviceId,
  pickHeaders,
  REQUEST_HEADERS,
  relayPath,
  sendableCloseCode,
  sendableCloseReason,
} from "./federation-protocol.js";

describe("link frames", () => {
  it("carry a type, a stream and the payload exactly", () => {
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    const frame = encodeFrame(FrameType.SocketBinary, 0xfffffffe, payload);
    expect(frame.length).toBe(FRAME_HEADER_BYTES + payload.length);
    expect(decodeFrame(frame)).toEqual({ type: FrameType.SocketBinary, stream: 0xfffffffe, payload });
  });

  it("refuse what this version does not define", () => {
    expect(decodeFrame(new Uint8Array([9, 0, 0, 0, 1]))).toBeNull();
    expect(decodeFrame(new Uint8Array([2, 0, 0]))).toBeNull();
    expect(() => encodeFrame(FrameType.Request, -1)).toThrow();
  });

  it("keep a body as bytes beside a JSON head, never inside it", () => {
    // Ciphertext goes here when encryption is on; base64 would cost a third.
    const body = new Uint8Array(1_000).map((_value, index) => index % 256);
    const encoded = encodeHeadBody({ method: "POST", path: "/api/x", headers: {} }, body);
    expect(encoded.length).toBeLessThan(body.length + 100);
    const decoded = decodeHeadBody<{ method: string }>(encoded);
    expect(decoded?.head.method).toBe("POST");
    expect([...decoded!.body]).toEqual([...body]);
    expect(decodeHeadBody(new Uint8Array([0, 0, 0, 99, 1]))).toBeNull();
  });

  it("are not deflated again when the body is ciphertext or already compressed", () => {
    expect(bodyIsIncompressible({ "content-type": "application/json", "content-encoding": "br" })).toBe(true);
    expect(bodyIsIncompressible({ "content-type": "application/json", "x-promptor-e2ee": "ab12" })).toBe(true);
    expect(bodyIsIncompressible({ "content-type": "application/octet-stream" })).toBe(true);   // a sealed request
    expect(bodyIsIncompressible({ "content-type": "application/json; charset=utf-8" })).toBe(false);
    expect(bodyIsIncompressible({ "content-type": "application/json", "content-encoding": "identity" })).toBe(false);
    expect(bodyIsIncompressible({})).toBe(false);
  });
});

describe("what a relay may carry", () => {
  it("accepts this device's API, query included", () => {
    expect(relayPath("/api/tabs/abc")).toBe("/api/tabs/abc");
    expect(relayPath("/api/tabs/abc/answers/page?before=10&limit=20")).toBe("/api/tabs/abc/answers/page?before=10&limit=20");
    expect(relayPath("/api/documents/d1/chunks/0?rev=r%2B1")).toBe("/api/documents/d1/chunks/0?rev=r%2B1");
  });

  it("refuses everything that is not plainly /api/", () => {
    for (const path of [
      "/hooks/codex/t/n",              // a CLI's callback
      "/a2a/claude/t/n",               // agent to agent, local only
      "/federation/link",              // the link itself
      "/ws",                           // sockets have their own route
      "/api/../hooks/x",               // dot segments
      "/api/./tabs",
      "/api/tabs/%2e%2e/x",            // encoded dots
      "/api/tabs%2fx",                 // encoded slash
      "/api/tabs%5cx",                 // encoded backslash
      "/api//tabs",
      "/api\\tabs",
      "/api/federation",               // the admin routes belong to the machine's own page
      "/api/federation/admin/leave",
      "/api/tabs?x=1#frag",
      "/api/tabs?x= 1",
      "",
      `/api/${"a".repeat(5_000)}`,
    ]) {
      expect(relayPath(path), path).toBeNull();
    }
  });

  it("forwards only the headers the far side may see", () => {
    const picked = pickHeaders({
      "content-type": "application/json",
      "if-none-match": "\"e\"",
      host: "127.0.0.1:4317",
      origin: "http://127.0.0.1:4317",
      cookie: "CF_Authorization=x",
      authorization: "Bearer y",
      "x-codex-promptor-token": "z",
    }, REQUEST_HEADERS);
    // Host and Origin are how a request would pass for local; the far side
    // builds its own. Credentials never travel.
    expect(picked).toEqual({ "content-type": "application/json", "if-none-match": "\"e\"" });
  });

  it("recognises device ids and nothing else", () => {
    expect(isDeviceId("1f0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a5b")).toBe(true);
    expect(isDeviceId("../../etc")).toBe(false);
    expect(isDeviceId("")).toBe(false);
  });
});

describe("closing across a relay", () => {
  it("passes on codes that can be sent and maps the ones that cannot", () => {
    expect(sendableCloseCode(4001)).toBe(4001);   // the key changed: the page must hear exactly this
    expect(sendableCloseCode(1008)).toBe(1008);
    expect(sendableCloseCode(1005)).toBe(1000);   // "no code" can be observed, never sent
    expect(sendableCloseCode(1006)).toBe(1011);
    expect(sendableCloseCode(undefined)).toBe(1000);
    expect(new TextEncoder().encode(sendableCloseReason("长".repeat(100))).length).toBeLessThanOrEqual(123);
  });
});
