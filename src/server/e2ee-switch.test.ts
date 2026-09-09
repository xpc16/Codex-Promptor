import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

/**
 * The switch tab's own rules: what it is called, and that there is only one.
 *
 * Both exist for the same reason. Encryption is a single machine-wide state,
 * but it is expressed as a tab -- so a sidebar has to make the one tab that
 * carries it obvious, and has to stop a second one from quietly appearing
 * beside it with a different key.
 */

const LOCAL_HOST = "127.0.0.1:4317";

describe("the encryption switch", () => {
  let app: PromptorApp;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-e2ee-switch-"));
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");
    app = await createApp(root);
    await app.ready();
  });

  afterEach(async () => {
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const local = { "x-codex-promptor-token": "", host: LOCAL_HOST, origin: `http://${LOCAL_HOST}` };
  const turnOn = (tabId: string, passphrase: string) => app.inject({
    method: "POST",
    url: `/api/tabs/${tabId}/session`,
    headers: { ...local, "x-codex-promptor-token": app.promptor.token },
    payload: { provider: "e2ee", workingDirectory: passphrase } as never,
  });

  it("names itself, so the tab that carries encryption is findable at a glance", async () => {
    const tabId = (await app.promptor.storage.createTab("新对话")).id;
    const response = await turnOn(tabId, "一句只有我知道的话");
    expect(response.statusCode).toBe(200);
    expect(response.json().data.bundle.tab.name).toBe("E2EE");
  });

  it("leaves a name the reader typed before connecting", async () => {
    const tabId = (await app.promptor.storage.createTab("工作机加密")).id;
    await turnOn(tabId, "一句只有我知道的话");
    expect((await app.promptor.storage.getTabMeta(tabId)).name).toBe("工作机加密");
  });

  it("refuses a second one, rather than letting tab order pick the winner", async () => {
    const first = (await app.promptor.storage.createTab("新对话")).id;
    await turnOn(first, "第一句口令");
    const declared = (await app.promptor.storage.getTabMeta(first)).session.e2ee!.fingerprint;

    const second = (await app.promptor.storage.createTab("新对话")).id;
    const refused = await turnOn(second, "另一句完全不同的口令");
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("E2EE_ALREADY_ON");

    // And the key in force is still the first one. Silently taking the second
    // would leave the device paired to the first typing a key that opens
    // nothing, with nothing on screen to say why.
    const bootstrap = await app.inject({
      method: "GET",
      url: "/api/bootstrap",
      headers: { "x-codex-promptor-token": app.promptor.token, host: "promptor.example.com" },
    });
    expect(bootstrap.json().data.e2ee.fingerprint).toBe(declared);
  });

  it("takes a new key on the tab that already holds one", async () => {
    // Rotation is not a conflict with itself. This is the path a reader takes
    // to change their passphrase, and it has to stay open.
    const tabId = (await app.promptor.storage.createTab("新对话")).id;
    await turnOn(tabId, "第一句口令");
    const before = (await app.promptor.storage.getTabMeta(tabId)).session.e2ee!.fingerprint;

    expect((await turnOn(tabId, "换了一句新的")).statusCode).toBe(200);
    expect((await app.promptor.storage.getTabMeta(tabId)).session.e2ee!.fingerprint).not.toBe(before);
  });

  it("frees the slot when the switch is closed, and refuses to reopen into a taken one", async () => {
    const first = (await app.promptor.storage.createTab("新对话")).id;
    await turnOn(first, "第一句口令");
    const closed = await app.inject({
      method: "POST",
      url: `/api/tabs/${first}/session/close`,
      headers: { ...local, "x-codex-promptor-token": app.promptor.token },
    });
    expect(closed.statusCode).toBe(200);

    // With it closed, a different tab may take over.
    const second = (await app.promptor.storage.createTab("新对话")).id;
    expect((await turnOn(second, "第二句口令")).statusCode).toBe(200);

    // And reopening the first would put two of them on at once, which is the
    // same thing the create route refuses -- so it refuses too.
    const reopened = await app.inject({
      method: "POST",
      url: `/api/tabs/${first}/terminal/reopen`,
      headers: { ...local, "x-codex-promptor-token": app.promptor.token },
    });
    expect(reopened.statusCode).toBe(409);
    expect(reopened.json().error.code).toBe("E2EE_ALREADY_ON");
  });
});
