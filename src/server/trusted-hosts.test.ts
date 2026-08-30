import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";
import { loadTrustedBrowserHosts, REMOTE_ACCESS_CONFIG } from "./trusted-hosts.js";

const roots: string[] = [];
const apps: PromptorApp[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.promptor.close();
    await app.close();
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "promptor-trusted-hosts-"));
  roots.push(root);
  return root;
}

async function writeConfig(root: string, trustedHosts: string[]): Promise<void> {
  const file = path.join(root, REMOTE_ACCESS_CONFIG);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ trustedHosts }));
}

describe("remote browser host configuration", () => {
  it("merges and normalizes private-file and environment hosts", async () => {
    const root = await temporaryRoot();
    await writeConfig(root, ["Promptor.VChord.App", "preview.example.com:8443"]);

    await expect(loadTrustedBrowserHosts(root, "promptor.vchord.app, other.example.com"))
      .resolves.toEqual(["promptor.vchord.app", "other.example.com", "preview.example.com:8443"]);
  });

  it("authorizes the configured remote origin without disabling token checks", async () => {
    const root = await temporaryRoot();
    await writeConfig(root, ["promptor.vchord.app"]);
    const app = await createApp(root);
    apps.push(app);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "promptor.vchord.app", origin: "https://promptor.vchord.app" },
    });
    expect(allowed.statusCode).toBe(200);

    const crossSite = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { host: "promptor.vchord.app", origin: "https://evil.example.com" },
    });
    expect(crossSite.statusCode).toBe(401);
  });
});
