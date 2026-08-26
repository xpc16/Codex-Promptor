import { gzipSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

describe("HTTP response compression", () => {
  let app: PromptorApp;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-compression-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    app.get("/__compression_test", async () => ({ data: "projection-state-".repeat(400) }));
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  it("negotiates Brotli for JSON", async () => {
    const response = await app.inject({ method: "GET", url: "/__compression_test", headers: { "accept-encoding": "br, gzip" } });
    expect(response.headers["content-encoding"]).toBe("br");
    const body = JSON.parse(brotliDecompressSync(response.rawPayload).toString("utf8"));
    expect(body.data).toContain("projection-state-");
  });

  it("falls back to gzip", async () => {
    const response = await app.inject({ method: "GET", url: "/__compression_test", headers: { "accept-encoding": "gzip" } });
    expect(response.headers["content-encoding"]).toBe("gzip");
    const body = JSON.parse(gunzipSync(response.rawPayload).toString("utf8"));
    expect(body.data.length).toBeGreaterThan(gzipSync("projection-state-").length);
  });
});
