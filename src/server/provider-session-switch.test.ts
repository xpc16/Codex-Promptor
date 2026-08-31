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

  it("retires a runner failure once a turn driven from the terminal succeeds", async () => {
    // lastError explains why the queue stopped, and only the queue cleared it.
    // A conversation whose turns are all typed into the terminal therefore kept
    // reporting one old failure forever, while visibly working the whole time.
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-runner-error-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("Runner error");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: { ...current.session, provider: "claude", state: "ready", workingDirectory: root, threadId: "session-1", sessionId: "session-1", connectedAt: isoNow() },
    }));
    const runtime = await app.promptor.storage.readRuntime(tab.id);
    runtime.runner.state = "error";
    runtime.runner.lastError = { code: "TURN_FAILED", message: "CLAUDE_TURN_NOT_FOUND:0e753900" };
    await app.promptor.storage.writeRuntime(tab.id, runtime);

    const manager = app.promptor.claude.get(tab.id);
    await manager.handleHook({ hook_event_name: "SessionStart", session_id: "session-1", cwd: root, transcript_path: path.join(root, "session-1.jsonl") });
    await manager.handleHook({ hook_event_name: "UserPromptSubmit", session_id: "session-1", prompt_id: "manual-1", prompt: "typed straight in" });
    await manager.handleHook({ hook_event_name: "Stop", session_id: "session-1", prompt_id: "manual-1", last_assistant_message: "done" });

    await eventually(async () => (await app!.promptor.storage.readRuntime(tab.id)).runner.lastError === null);
    const cleared = await app.promptor.storage.readRuntime(tab.id);
    expect(cleared.runner.state).toBe("paused");
  });

  it("binds a new Codex conversation to the thread its first prompt creates", async () => {
    // Codex's TUI has no thread until something is submitted, so a new
    // conversation opens with none. The SessionStart hook that arrives with the
    // first prompt is the only thing that can supply one, and until this bound
    // it the conversation stayed unrunnable for the rest of its life.
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-codex-adopt-"));
    const staticRoot = path.join(root, "dist", "client");
    await mkdir(staticRoot, { recursive: true });
    await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>test</title>", "utf8");
    app = await createApp(root);
    await app.ready();

    const tab = await app.promptor.storage.createTab("Codex adopt");
    await app.promptor.storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: {
        ...current.session,
        provider: "codex",
        state: "ready",
        reopenOnLaunch: true,
        workingDirectory: root,
        threadId: null,
        sessionId: null,
        connectedAt: isoNow(),
      },
    }));

    await app.promptor.codexTui.get(tab.id).handleHook({
      hook_event_name: "SessionStart",
      session_id: "01a05706-ef06-7b11-8c3b-ada4281ea2cb",
      cwd: root,
      transcript_path: path.join(root, "missing-rollout.jsonl"),
    });

    await eventually(async () => (await app!.promptor.storage.getTabMeta(tab.id)).session.threadId === "01a05706-ef06-7b11-8c3b-ada4281ea2cb");
    const bound = await app.promptor.storage.getTabMeta(tab.id);
    expect(bound.session).toMatchObject({ provider: "codex", state: "ready", sessionId: "01a05706-ef06-7b11-8c3b-ada4281ea2cb" });
    // Nothing was switched away from, so no switch is reported.
    expect(bound.session.lastThreadSwitch).toBeNull();
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
