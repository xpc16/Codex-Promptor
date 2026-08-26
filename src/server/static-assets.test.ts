import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

describe("static client assets", () => {
  let app: PromptorApp | null = null;
  let root = "";

  afterEach(async () => {
    if (app) {
      await app.promptor.close();
      await app.close();
      app = null;
    }
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = "";
    }
  });

  it("serves a hashed asset created after the server starts", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-static-"));
    const staticRoot = path.join(root, "dist", "client");
    const assetRoot = path.join(staticRoot, "assets");
    await mkdir(assetRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");

    app = await createApp(root);
    await app.ready();

    await writeFile(path.join(assetRoot, "index-new-hash.js"), "window.__assetLoaded = true;", "utf8");
    const response = await app.inject({ method: "GET", url: "/assets/index-new-hash.js" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(response.body).toContain("__assetLoaded");
  });
});
