import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";

describe("Codex compaction terminal synchronization", () => {
  let app: PromptorApp | null = null;
  let root = "";

  afterEach(async () => {
    if (app) {
      await app.promptor.close();
      await app.close();
      app = null;
    }
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("requests one authoritative PTY snapshot after duplicate compaction events", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "codex-promptor-compact-sync-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("compact sync");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: { ...current.session, state: "ready", workingDirectory: root, threadId: "thread-compact", sessionId: "thread-compact", connectedAt: isoNow() },
    }));
    const snapshot = vi.spyOn(app.promptor.pty, "snapshot").mockReturnValue({
      generation: "generation-compact",
      startOffset: 0,
      endOffset: 7,
      reset: true,
      dataBase64: Buffer.from("repaint").toString("base64"),
    });
    const rpc = app.promptor.codex.get(tab.id).rpc;

    rpc.emit("threadCompacted", { threadId: "thread-compact", turnId: "turn-1" });
    rpc.emit("threadCompacted", { threadId: "thread-compact", turnId: "turn-1" });

    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledWith(tab.id, {}), { timeout: 1_500 });
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
});
