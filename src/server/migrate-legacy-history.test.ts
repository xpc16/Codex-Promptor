import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { isoNow, newPrompt } from "../shared/schemas.js";
import { StorageService } from "./storage.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("legacy Codex history migration", () => {
  it("dry-runs without writes, applies once, preserves pending prompts and rolls back", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-migration-root-"));
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-migration-codex-"));
    temporaryDirectories.push(root, codexHome);
    const storage = new StorageService(root);
    await storage.ensure();
    const tab = await storage.createTab("migration fixture");
    const threadId = "00000000-0000-4000-8000-000000000001";
    await storage.updateTab(tab.id, (current) => ({
      ...current,
      updatedAt: isoNow(),
      session: {
        ...current.session,
        provider: "codex",
        state: "closed",
        workingDirectory: root,
        threadId,
        sessionId: threadId,
      },
    }));
    const prompts = await storage.readPromptsOnly(tab.id);
    prompts.prompts.push(newPrompt("keep this pending"));
    prompts.revision += 1;
    prompts.updatedAt = isoNow();
    await storage.writePrompts(tab.id, prompts);

    const sessionDir = path.join(codexHome, "sessions", "2026", "08", "31");
    await fs.mkdir(sessionDir, { recursive: true });
    const rollout = path.join(sessionDir, `rollout-fixture-${threadId}.jsonl`);
    const records = [
      { timestamp: "2026-08-31T02:00:00.000Z", payload: { type: "task_started", turn_id: "turn-1" } },
      { timestamp: "2026-08-31T02:00:01.000Z", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "UserMessage", content: [{ text: "imported prompt" }] } } },
      { timestamp: "2026-08-31T02:00:02.000Z", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "imported answer" } },
    ];
    await fs.writeFile(rollout, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");

    const originals = await readTabFiles(storage, tab.id);
    const dry = await runMigration(root, codexHome, ["--tab", tab.id]);
    expect(JSON.parse(dry.stdout).tabs[0]).toMatchObject({ status: "dry-run", parsedTurns: 1, unparsedBoundaryTurns: 0 });
    expect(await readTabFiles(storage, tab.id)).toEqual(originals);
    await expect(fs.access(path.join(root, "data", "migrations"))).rejects.toThrow();

    const applied = await runMigration(root, codexHome, ["--apply", "--tab", tab.id]);
    expect(JSON.parse(applied.stdout).tabs[0].status).toBe("applied");
    const migrated = await storage.readTab(tab.id);
    expect(migrated.prompts.prompts.map((prompt) => [prompt.text, prompt.status])).toEqual([
      ["imported prompt", "completed"],
      ["keep this pending", "pending"],
    ]);
    expect(migrated.answers.answers[0]).toMatchObject({ prompt: "imported prompt", finalAnswer: "imported answer", status: "completed" });
    const manifestPath = path.join(root, "data", "migrations", "legacy-history-v1", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(manifest.entries[0]).toMatchObject({
      tabId: tab.id,
      sourceHash: expect.any(String),
      sourceHashAfter: manifest.entries[0].sourceHash,
      status: "applied",
    });

    const afterFirstApply = await readTabFiles(storage, tab.id);
    const repeated = await runMigration(root, codexHome, ["--apply", "--tab", tab.id]);
    expect(JSON.parse(repeated.stdout).tabs[0].status).toBe("already-applied");
    expect(await readTabFiles(storage, tab.id)).toEqual(afterFirstApply);

    await runMigration(root, codexHome, ["--rollback", tab.id]);
    expect(await readTabFiles(storage, tab.id)).toEqual(originals);
    expect(JSON.parse(await fs.readFile(manifestPath, "utf8")).entries[0].status).toBe("rolled-back");
  }, 30_000);
});

async function runMigration(root: string, codexHome: string, extra: string[]) {
  return execFileAsync(process.execPath, [
    "--import",
    "tsx",
    path.join(process.cwd(), "scripts", "migrate-legacy-history.mjs"),
    "--root",
    root,
    ...extra,
  ], { cwd: process.cwd(), env: { ...process.env, CODEX_HOME: codexHome }, windowsHide: true });
}

async function readTabFiles(storage: StorageService, tabId: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of [storage.tabPath(tabId), storage.promptPath(tabId), storage.answerPath(tabId), storage.runtimePath(tabId)]) {
    result[path.basename(file)] = await fs.readFile(file, "utf8");
  }
  return result;
}
