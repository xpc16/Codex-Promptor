import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isoNow } from "../shared/schemas.js";
import { createApp, type PromptorApp } from "./app.js";

describe("native provider session switches", () => {
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

  it("rebinds a Claude tab and reconciles the newly selected transcript", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-native-switch-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("Claude switch");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: {
        ...current.session,
        provider: "claude",
        state: "ready",
        reopenOnLaunch: true,
        workingDirectory: root,
        threadId: "session-old",
        sessionId: "session-old",
        connectedAt: isoNow(),
      },
    }));

    const transcriptPath = path.join(root, "session-new.jsonl");
    await writeFile(transcriptPath, [
      JSON.stringify({ type: "user", uuid: "user", parentUuid: null, promptId: "prompt", origin: { kind: "human" }, message: { role: "user", content: "new prompt" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant", parentUuid: "user", message: { id: "message", role: "assistant", content: [{ type: "text", text: "new answer" }], stop_reason: "end_turn" } }),
    ].join("\n"), "utf8");

    const manager = app.promptor.claude.get(tab.id);
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-old", cwd: root, transcript_path: path.join(root, "session-old.jsonl"), source: "resume" });
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-new", cwd: root, transcript_path: transcriptPath, source: "resume" });

    await eventually(async () => {
      const current = await app!.promptor.storage.readTab(tab.id);
      return current.tab.session.threadId === "session-new"
        && current.answers.answers.some((answer) => answer.threadId === "session-new" && answer.finalAnswer === "new answer");
    });
    const bundle = await app.promptor.storage.readTab(tab.id);
    expect(bundle.tab.session).toMatchObject({
      provider: "claude",
      state: "ready",
      threadId: "session-new",
      sessionId: "session-new",
      lastThreadSwitch: { fromThreadId: "session-old", toThreadId: "session-new", method: "session/start" },
    });
    expect(bundle.answers.answers).toContainEqual(expect.objectContaining({ threadId: "session-new", finalAnswer: "new answer" }));
  });
});

async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition was not met");
}
