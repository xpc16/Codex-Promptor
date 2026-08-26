import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";

describe("explicit queue start", () => {
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

  async function makeTab(name: string, desiredState: "paused" | "armed" | "running") {
    const tab = await app!.promptor.storage.createTab(name);
    await app!.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: { ...current.session, state: "ready", workingDirectory: root, threadId: `thread-${tab.id}`, sessionId: `thread-${tab.id}`, connectedAt: isoNow() },
    }));
    const bundle = await app!.promptor.storage.readTab(tab.id);
    await app!.promptor.storage.writeRuntime(tab.id, {
      ...bundle.runtime,
      runner: { ...bundle.runtime.runner, desiredState },
    });
    return tab;
  }

  const addPrompt = (tabId: string, text: string) => app!.inject({
    method: "POST",
    url: `/api/tabs/${tabId}/prompts`,
    headers: { "x-codex-promptor-token": app!.promptor.token },
    payload: { text },
  });

  it("starts an armed queue when a prompt is added, without a separate start click", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-armed-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await makeTab("预备滚动", "armed");
    const start = vi.spyOn(app.promptor.runners.get(tab.id), "start").mockResolvedValue();

    expect((await addPrompt(tab.id, "第一条")).statusCode).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("gives a brand new conversation an armed queue", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-armed-default-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("新对话");
    const bundle = await app.promptor.storage.readTab(tab.id);
    expect(bundle.runtime.runner.desiredState).toBe("armed");
  });

  it.each([false, true])("does not start a paused queue when a prompt is added (existing pending: %s)", async (withExistingPending) => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-prompt-autostart-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    // A new conversation is armed, so the pause has to be stated: this test is
    // about a queue the user deliberately stopped.
    const tab = await makeTab("暂停队列追加", "paused");
    if (withExistingPending) {
      const before = await app.promptor.storage.readTab(tab.id);
      before.prompts.prompts.push(newPrompt("先前待执行", "queue"));
      await app.promptor.storage.writePrompts(tab.id, before.prompts);
    }

    const start = vi.spyOn(app.promptor.runners.get(tab.id), "start").mockResolvedValue();
    const response = await app.inject({
      method: "POST",
      url: `/api/tabs/${tab.id}/prompts`,
      headers: { "x-codex-promptor-token": app.promptor.token },
      payload: { text: "后来追加" },
    });

    expect(response.statusCode).toBe(200);
    expect(start).not.toHaveBeenCalled();
    const after = await app.promptor.storage.readTab(tab.id);
    expect(after.prompts.prompts.map((prompt) => prompt.text)).toEqual(withExistingPending ? ["先前待执行", "后来追加"] : ["后来追加"]);
    expect(after.runtime.runner.desiredState).toBe("paused");
  });

  it("moves an interrupted prompt back to pending without starting the queue", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-prompt-retry-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await makeTab("中断后重试", "paused");
    const before = await app.promptor.storage.readTab(tab.id);
    const interrupted = newPrompt("重新排队", "queue");
    interrupted.status = "interrupted";
    interrupted.threadId = `thread-${tab.id}`;
    interrupted.completedAt = isoNow();
    interrupted.error = { code: "TURN_INTERRUPTED", message: "interrupted" };
    before.prompts.prompts.push(interrupted);
    await app.promptor.storage.writePrompts(tab.id, before.prompts);

    const start = vi.spyOn(app.promptor.runners.get(tab.id), "start").mockResolvedValue();
    const response = await app.inject({
      method: "POST",
      url: `/api/tabs/${tab.id}/prompts/${interrupted.id}/retry`,
      headers: { "x-codex-promptor-token": app.promptor.token },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(start).not.toHaveBeenCalled();
    const after = await app.promptor.storage.readTab(tab.id);
    expect(after.prompts.prompts[0]).toMatchObject({ status: "pending", completedAt: null, error: null });
    expect(after.runtime.runner.desiredState).toBe("paused");
  });
});
