import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

/**
 * Keeping a socket alive through whatever sits between the page and this
 * process, and knowing when one dies anyway.
 *
 * Two weeks of ledger showed an idle remote page reconnecting every 100
 * seconds -- Cloudflare's idle timeout -- and nothing in the ledger that
 * could have said so: it counted messages, never connections. Both are
 * fixed here and both are pinned.
 */
describe("websocket keepalive and connection accounting", () => {
  let app: PromptorApp;
  let root: string;
  let address: string;
  const sockets: WebSocket[] = [];
  const previousKeepalive = process.env.CODEX_PROMPTOR_WS_KEEPALIVE_MS;

  beforeEach(async () => {
    // Fast enough to observe in a test; the default is 30s.
    process.env.CODEX_PROMPTOR_WS_KEEPALIVE_MS = "1000";
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-keepalive-"));
    const staticRoot = path.join(root, "dist", "client", "assets");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>test</title>", "utf8");
    await writeFile(path.join(staticRoot, "index-DqODgTnP.js"), "console.log('hashed')", "utf8");
    app = await createApp(root);
    address = await app.listen({ host: "127.0.0.1", port: 0 });
  });

  afterEach(async () => {
    if (previousKeepalive === undefined) delete process.env.CODEX_PROMPTOR_WS_KEEPALIVE_MS;
    else process.env.CODEX_PROMPTOR_WS_KEEPALIVE_MS = previousKeepalive;
    await Promise.all(sockets.splice(0).map((socket) => new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) { resolve(); return; }
      socket.on("close", () => resolve());
      socket.close();
      setTimeout(resolve, 200);
    })));
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const wsUrl = () => `${address.replace(/^http/, "ws")}/ws?token=${encodeURIComponent(app.promptor.token)}`;

  /** A loopback peer under a public Host is exactly what cloudflared looks like from here. */
  const open = (headers: Record<string, string> = {}): Promise<WebSocket> => new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl(), { headers });
    sockets.push(socket);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });

  const rollup = async (): Promise<Record<string, any>> => {
    const response = await app.inject({ method: "GET", url: "/api/diagnostics/traffic", headers: { "x-codex-promptor-token": app.promptor.token } });
    return response.json().data.rollup.entries;
  };

  it("pings a tunnelled connection before an intermediary would drop it", async () => {
    const socket = await open({ host: "promptor.example.com" });
    const pinged = new Promise<void>((resolve) => socket.once("ping", () => resolve()));
    await expect(Promise.race([
      pinged.then(() => "pinged"),
      new Promise((resolve) => setTimeout(() => resolve("silent"), 2_500)),
    ])).resolves.toBe("pinged");
    // Real wire cost with no payload behind it, so it is on the books under
    // its own name rather than folded into the compression ratio.
    const entries = await rollup();
    expect(entries["out:ws:tunnel:ping"]).toMatchObject({ bytes: 2 });
    expect(entries["out:ws:tunnel:ping"].count).toBeGreaterThanOrEqual(1);
  });

  it("leaves loopback alone, which has nothing in between to keep alive", async () => {
    const socket = await open();
    let pings = 0;
    socket.on("ping", () => { pings += 1; });
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(pings).toBe(0);
    expect(Object.keys(await rollup()).some((key) => key.endsWith(":ping"))).toBe(false);
  });

  it("records each connection's open, and its close with code and lifetime", async () => {
    const socket = await open({ host: "promptor.example.com" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.close(1000, "done");
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const entries = await rollup();
    expect(entries["in:conn:tunnel:open"]).toMatchObject({ count: 1, bytes: 0 });
    // Lifetime rides in the bytes slot: this one lived about a second. An
    // intermediary's timeout would show here as many 1006s with a mean just
    // past its limit -- the reading the message ledger could never give.
    const close = entries["in:conn:tunnel:close.1000"];
    expect(close).toMatchObject({ count: 1 });
    expect(close.bytes).toBeGreaterThanOrEqual(1);
    expect(close.bytes).toBeLessThan(5);
  });

  it("counts a request's headers inbound, not only its body", async () => {
    // A GET has no body. Over the tunnel it still carries about a kilobyte of
    // cookie and token, which used to be recorded as nothing at all.
    const response = await fetch(`${address}/api/bootstrap`, {
      headers: { "x-codex-promptor-token": app.promptor.token, cookie: `CF_Authorization=${"j".repeat(700)}` },
    });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const entries = await rollup();
    const inbound = entries["in:http:local:GET /api/bootstrap"];
    expect(inbound).toMatchObject({ count: 1 });
    expect(inbound.bytes).toBeGreaterThan(700);
  });

  it("lets a hashed asset be cached for a year while index.html is not", async () => {
    const asset = await fetch(`${address}/assets/index-DqODgTnP.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    await asset.arrayBuffer();
    const page = await fetch(`${address}/index.html`);
    expect(page.headers.get("cache-control")).not.toContain("immutable");
    await page.arrayBuffer();
    // A miss for a name from an older build must not be pinned.
    const missing = await fetch(`${address}/assets/index-Old1Old1.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control") ?? "").not.toContain("immutable");
    await missing.arrayBuffer();
  });
});
