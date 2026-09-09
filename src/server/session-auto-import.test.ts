import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type PromptorApp } from "./app.js";

/**
 * The import itself, through the real app: tabs that carry their history and
 * start nothing.
 *
 * A first run can bring in dozens at once, and opening them would mean that
 * many PowerShells and that many agents. So what lands is a closed tab.
 * Everything else here is about the second launch being free.
 */

const line = (record: unknown) => JSON.stringify(record);
const meta = (id: string, cwd: string) => line({ type: "session_meta", payload: { id, cwd } });

/**
 * One turn as a rollout records it. `task_started` and `task_complete` are
 * what the parser counts; the closing answer rides on the completion event.
 */
const turn = (turnId: string, text: string, answer: string) => [
  line({ type: "event_msg", payload: { type: "task_started", turn_id: turnId }, timestamp: "2026-09-01T00:00:00Z" }),
  line({ type: "event_msg", payload: { type: "user_message", turn_id: turnId, message: text } }),
  line({ type: "response_item", payload: { type: "message", role: "user", turn_id: turnId, content: [{ type: "input_text", text }] } }),
  line({ type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: answer }, timestamp: "2026-09-01T00:01:00Z" }),
].join("\n");

describe("importing conversations that never had a tab", () => {
  let app: PromptorApp;
  let root: string;
  const previousProfile = process.env.USERPROFILE;
  const previousSwitch = process.env.CODEX_PROMPTOR_AUTO_IMPORT;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-auto-import-"));
    const home = path.join(root, "home");
    const sessions = path.join(home, ".codex", "sessions", "2026", "09", "01");
    await mkdir(sessions, { recursive: true });
    await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
    await mkdir(path.join(root, "dist", "client"), { recursive: true });
    await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html><title>t</title>", "utf8");

    await writeFile(path.join(sessions, "rollout-long.jsonl"), [
      meta("long-session", "C:\\project"),
      turn("t1", "the opening prompt", "the first answer"),
      turn("t2", "prompt two", "answer two"),
      turn("t3", "prompt three", "answer three"),
      turn("t4", "prompt four", "answer four"),
    ].join("\n"), "utf8");
    await writeFile(path.join(sessions, "rollout-short.jsonl"), [
      meta("short-session", "C:\\project"),
      turn("s1", "asked once", "answered once"),
    ].join("\n"), "utf8");

    process.env.USERPROFILE = home;
    delete process.env.CODEX_PROMPTOR_AUTO_IMPORT;
    app = await createApp(root);
    await app.ready();
  });

  afterEach(async () => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
    if (previousSwitch === undefined) delete process.env.CODEX_PROMPTOR_AUTO_IMPORT;
    else process.env.CODEX_PROMPTOR_AUTO_IMPORT = previousSwitch;
    await app.promptor.close();
    await app.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  it("lands as a closed tab that carries its history and started nothing", async () => {
    expect(await app.promptor.importDiscoveredSessions()).toEqual({ imported: 1, failed: 0 });

    const tabs = await app.promptor.storage.listTabMeta();
    expect(tabs).toHaveLength(1);
    const tab = tabs[0]!;
    expect(tab.name, "named after the opening prompt").toBe("the opening prompt");
    expect(tab.session.provider).toBe("codex");
    expect(tab.session.threadId).toBe("long-session");
    expect(tab.session.workingDirectory).toBe("C:\\project");
    // Closed, and not queued for the next launch: dozens of imported
    // conversations must not become dozens of agents on restart.
    expect(tab.session.state).toBe("closed");
    expect(tab.session.reopenOnLaunch).toBe(false);
    expect(app.promptor.pty.has(tab.id), "no terminal was started").toBe(false);

    const bundle = await app.promptor.storage.readTab(tab.id);
    expect(bundle.prompts.prompts.map((item) => item.text)).toContain("the opening prompt");
    expect(bundle.answers.answers.map((item) => item.finalAnswer)).toContain("the first answer");
  });

  it("puts them somewhere that does not triple the sidebar", async () => {
    await app.promptor.importDiscoveredSessions();
    const index = await app.promptor.storage.readIndex();
    const group = index.groups.find((item) => item.name === "已导入");
    expect(group, "a group to collapse them into").toBeTruthy();
    expect(group!.collapsed).toBe(true);
    expect(index.tabs[0]!.groupId).toBe(group!.id);
  });

  it("does nothing the second time", async () => {
    await app.promptor.importDiscoveredSessions();
    expect(await app.promptor.importDiscoveredSessions()).toEqual({ imported: 0, failed: 0 });
    expect(await app.promptor.storage.listTabMeta()).toHaveLength(1);
  });

  it("leaves a conversation of three exchanges or fewer alone", async () => {
    await app.promptor.importDiscoveredSessions();
    const tabs = await app.promptor.storage.listTabMeta();
    expect(tabs.map((tab) => tab.session.threadId)).not.toContain("short-session");
  });

  it("does nothing at all when it is switched off", async () => {
    process.env.CODEX_PROMPTOR_AUTO_IMPORT = "0";
    expect(await app.promptor.importDiscoveredSessions()).toEqual({ imported: 0, failed: 0 });
    expect(await app.promptor.storage.listTabMeta()).toHaveLength(0);
  });
});
