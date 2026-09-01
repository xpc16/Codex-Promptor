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

  it("keeps an unconfirmed submission distinct from a stalled active turn", async () => {
    // Reconciling forever is the right policy -- a prompt that may have run
    // must not be failed. It still has no provider turn id, though, so calling
    // it a stalled turn creates a warning that real turn progress cannot clear.
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-unconfirmed-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("未确认的提交");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: { ...current.session, provider: "codex", state: "ready", workingDirectory: root, threadId: "thread-1", sessionId: "thread-1", connectedAt: isoNow() },
    }));
    const runtime = await app.promptor.storage.readRuntime(tab.id);
    runtime.runner.state = "dispatching";
    runtime.runner.activePromptId = "prompt-1";
    runtime.runner.activeTurnId = null;
    await app.promptor.storage.writeRuntime(tab.id, runtime);

    app.promptor.codexTui.get(tab.id).emit("submissionUnconfirmed", {});

    await eventually(async () => (await app!.promptor.storage.readRuntime(tab.id)).runner.state === "reconciling");
    const reconciling = await app.promptor.storage.readRuntime(tab.id);
    expect(reconciling.runner.activeTurnId).toBeNull();
    expect(reconciling.runner.stalledSince).toBeNull();
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
    // A queue control changes the runtime and nothing else, so that is all it
    // reports -- not a copy of the conversation the caller is already showing.
    const data = response.json().data;
    expect(data.runtime.runner).toBeDefined();
    expect(data.prompts).toBeUndefined();
    expect(data.answers).toBeUndefined();
  });
});

async function eventually(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met");
}
