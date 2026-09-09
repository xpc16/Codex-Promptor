import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TabMeta } from "../shared/schemas.js";
import { discoverSessions, importedSessionIds, importedTabName } from "./session-import.js";

/**
 * The filter is the whole feature. A machine that has used these CLIs for a
 * while accumulates far more sessions than conversations worth keeping, most
 * of them a question and an answer; importing all of them would bury the ones
 * that matter.
 */

const codexMeta = (id: string, cwd: string) =>
  JSON.stringify({ type: "session_meta", payload: { id, cwd, timestamp: "2026-09-01T00:00:00Z" } });
const codexPrompt = (text: string) =>
  JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: text } });
const codexOldPrompt = (text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const claudePrompt = (sessionId: string, cwd: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", sessionId, cwd, message: { role: "user", content: text }, ...extra });

const FOUR = ["prompt one", "prompt two", "prompt three", "prompt four"];
const THREE = ["prompt one", "prompt two", "prompt three"];

describe("finding conversations worth a tab", () => {
  let root: string;
  let codexHome: string;
  let claudeHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-import-"));
    codexHome = path.join(root, ".codex");
    claudeHome = path.join(root, ".claude");
    await mkdir(path.join(codexHome, "sessions", "2026", "09", "01"), { recursive: true });
    await mkdir(path.join(claudeHome, "projects", "D--work"), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const codexRollout = async (name: string, lines: string[]) =>
    writeFile(path.join(codexHome, "sessions", "2026", "09", "01", `${name}.jsonl`), lines.join("\n"), "utf8");
  const claudeSession = async (id: string, lines: string[], dir = "D--work") => {
    await mkdir(path.join(claudeHome, "projects", dir), { recursive: true });
    await writeFile(path.join(claudeHome, "projects", dir, `${id}.jsonl`), lines.join("\n"), "utf8");
  };
  const find = (taken: Iterable<string> = []) =>
    discoverSessions({ codex: codexHome, claude: claudeHome }, new Set(taken));

  it("takes a long conversation and leaves a short one", async () => {
    await codexRollout("rollout-long", [codexMeta("long-1", "C:\\project"), ...FOUR.map(codexPrompt)]);
    await codexRollout("rollout-short", [codexMeta("short-1", "C:\\project"), ...THREE.map(codexPrompt)]);

    const found = await find();
    expect(found.map((item) => item.sessionId)).toEqual(["long-1"]);
    expect(found[0]!.workingDirectory).toBe("C:\\project");
    expect(found[0]!.provider).toBe("codex");
  });

  it("does not count what Codex wrote as the person", async () => {
    // The environment block, the aborted-turn notice and the skill catalogue
    // all arrive with role "user". Counting them would let a conversation
    // nobody had past the filter.
    await codexRollout("rollout-noise", [
      codexMeta("noise-1", "C:\\project"),
      codexPrompt("a real prompt"),
      codexPrompt("<environment_context>\n  <cwd>C:\\project</cwd>\n</environment_context>"),
      codexPrompt("<turn_aborted>"),
      codexPrompt("<recommended_plugins>"),
      codexPrompt("<skill>"),
    ]);
    expect(await find()).toHaveLength(0);
  });

  it("reads a rollout from before Codex marked user messages", async () => {
    await codexRollout("rollout-old", [codexMeta("old-1", "C:\\project"), ...FOUR.map(codexOldPrompt)]);
    expect((await find()).map((item) => item.sessionId)).toEqual(["old-1"]);
  });

  it("keeps a resumed rollout under its own id", async () => {
    // A rollout produced by `/resume` carries a second session_meta naming the
    // conversation it continued. Taking the later one would file this
    // conversation under another's id -- and then skip it as already imported.
    await codexRollout("rollout-resumed", [
      codexMeta("resumed-own", "C:\\project"),
      codexPrompt("prompt one"),
      codexMeta("resumed-source", "C:\\elsewhere"),
      ...["prompt two", "prompt three", "prompt four"].map(codexPrompt),
    ]);
    const found = await find();
    expect(found.map((item) => item.sessionId)).toEqual(["resumed-own"]);
    expect(found[0]!.workingDirectory).toBe("C:\\project");
  });

  it("skips what already has a tab", async () => {
    await codexRollout("rollout-known", [codexMeta("known-1", "C:\\project"), ...FOUR.map(codexPrompt)]);
    expect(await find(["known-1"])).toHaveLength(0);
  });

  it("takes a Claude session and ignores its subagents", async () => {
    await claudeSession("claude-1", FOUR.map((text) => claudePrompt("claude-1", "C:\\project", text)));
    await mkdir(path.join(claudeHome, "projects", "D--work", "claude-1", "subagents"), { recursive: true });
    await writeFile(
      path.join(claudeHome, "projects", "D--work", "claude-1", "subagents", "agent-x.jsonl"),
      FOUR.map((text) => claudePrompt("agent-x", "C:\\project", text)).join("\n"),
      "utf8",
    );

    const found = await find();
    expect(found.map((item) => item.sessionId)).toEqual(["claude-1"]);
    expect(found[0]!.provider).toBe("claude");
  });

  it("ignores Claude's own records and a subagent's side of the transcript", async () => {
    await claudeSession("claude-noise", [
      claudePrompt("claude-noise", "C:\\project", "a real prompt"),
      claudePrompt("claude-noise", "C:\\project", "inserted context", { isMeta: true }),
      claudePrompt("claude-noise", "C:\\project", "a subagent talking to itself", { isSidechain: true }),
      claudePrompt("claude-noise", "C:\\project", "<command-name>/model</command-name>"),
      claudePrompt("claude-noise", "C:\\project", "<local-command-stdout>done</local-command-stdout>"),
      claudePrompt("claude-noise", "C:\\project", "[Request interrupted by user]"),
    ]);
    expect(await find()).toHaveLength(0);
  });

  it("names a tab after the opening prompt, not the id", async () => {
    // A list of session ids is a list of nothing. The first prompt is what
    // makes a row recognisable, cut where a sidebar stops showing it.
    await codexRollout("rollout-short-name", [
      codexMeta("named-1", "C:\\project"),
      codexPrompt("a short opening prompt"),
      ...["prompt two", "prompt three", "prompt four"].map(codexPrompt),
    ]);
    await codexRollout("rollout-long-name", [
      codexMeta("named-2", "C:\\project"),
      codexPrompt("an opening prompt long enough that a sidebar would have to cut it short"),
      ...["prompt two", "prompt three", "prompt four"].map(codexPrompt),
    ]);
    const byId = new Map((await find()).map((item) => [item.sessionId, item]));
    expect(importedTabName(byId.get("named-1")!)).toBe("a short opening prompt");
    expect(importedTabName(byId.get("named-2")!)).toBe("an opening prompt long e…");
  });

  it("counts both ids a tab can hold as taken", async () => {
    const tabs = [
      { session: { threadId: "thread-a", sessionId: null } },
      { session: { threadId: null, sessionId: "session-b" } },
    ] as unknown as TabMeta[];
    expect([...importedSessionIds(tabs)].sort()).toEqual(["session-b", "thread-a"]);
  });
});
