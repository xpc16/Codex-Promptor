import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";

describe("runner controls", () => {
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

  it("routes the interrupt action to the selected tab runner", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-runner-control-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("中断当前 Prompt");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-interrupt", sessionId: "thread-interrupt", connectedAt: isoNow() },
    }));
    const interruptCurrent = vi.spyOn(app.promptor.runners.get(tab.id), "interruptCurrent").mockResolvedValue(true);

    const response = await app.inject({
      method: "POST",
      url: `/api/tabs/${tab.id}/runner/interrupt`,
      headers: { "x-codex-promptor-token": app.promptor.token },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(interruptCurrent).toHaveBeenCalledTimes(1);
    expect(response.json().data.tab.id).toBe(tab.id);
  });
});
