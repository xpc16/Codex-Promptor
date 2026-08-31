#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { locateCodexRollout, readCodexRollout } from "../src/server/codex-history.ts";
import { syncHistory } from "../src/server/history.ts";
import { StorageService, writeFileAtomicWithRetry } from "../src/server/storage.ts";

const execFileAsync = promisify(execFile);
const MIGRATION_ID = "legacy-history-v1";
const PARSER_VERSION = 2;

const args = parseArgs(process.argv.slice(2));
const rootDir = path.resolve(args.root ?? process.cwd());
const storage = new StorageService(rootDir);
const manifestPath = path.join(storage.dataDir, "migrations", MIGRATION_ID, "manifest.json");

if (args.rollback) {
  await rollbackTab(args.rollback);
} else {
  const existingManifest = await readJson(manifestPath, { migrationId: MIGRATION_ID, parserVersion: PARSER_VERSION, entries: [] });
  const cliVersion = await codexVersion();
  const tabs = (await storage.listTabMeta()).filter((tab) => tab.session.provider === "codex" && tab.session.threadId);
  const selected = args.tab ? tabs.filter((tab) => tab.id === args.tab) : tabs;
  const report = [];

  for (const tab of selected) {
    const threadId = tab.session.threadId;
    const source = await locateCodexRollout(threadId);
    if (!source) {
      report.push({ tabId: tab.id, name: tab.name, threadId, source: null, status: "source-not-found" });
      continue;
    }
    const [analysis, thread] = await Promise.all([
      analyzeRollout(source),
      readCodexRollout(source, threadId),
    ]);
    const sourceHash = analysis.sourceHash;
    const previous = existingManifest.entries.find((entry) => entry.tabId === tab.id && entry.sourceHash === sourceHash && entry.status === "applied");
    const unresolved = existingManifest.entries.find((entry) => entry.tabId === tab.id
      && entry.sourceHash === sourceHash
      && (entry.status === "pending" || entry.status === "failed"));
    const item = {
      tabId: tab.id,
      name: tab.name,
      threadId,
      source,
      sourceHash,
      sourceBytes: analysis.bytes,
      shape: analysis.shape,
      boundaryTurns: analysis.boundaryTurns,
      parsedTurns: thread.turns.length,
      unparsedBoundaryTurns: Math.max(0, analysis.boundaryTurns - thread.turns.length),
      terminalTurns: thread.turns.filter((turn) => turn.status !== "running").length,
      unknownBoundaryRecords: analysis.unknownBoundaryRecords,
      status: previous ? "already-applied" : unresolved ? "recovery-required" : args.apply ? "pending" : "dry-run",
    };
    report.push(item);
    if (!args.apply || previous || unresolved) continue;

    const bundle = await storage.readTab(tab.id);
    if (["starting", "running"].includes(bundle.runtime.terminal.state) || bundle.runtime.runner.activePromptId || bundle.runtime.runner.activeTurnId) {
      item.status = "active-tab-refused";
      continue;
    }

    const backupDir = path.join(storage.backupsDir, MIGRATION_ID, tab.id, sourceHash.slice(0, 16));
    await backupTab(tab.id, backupDir);
    const startedAt = new Date().toISOString();
    const entry = {
      migrationId: MIGRATION_ID,
      parserVersion: PARSER_VERSION,
      cliVersion,
      tabId: tab.id,
      threadId,
      source,
      sourceHash,
      sourceBytes: analysis.bytes,
      shape: analysis.shape,
      boundaryTurns: analysis.boundaryTurns,
      parsedTurns: thread.turns.length,
      unparsedBoundaryTurns: item.unparsedBoundaryTurns,
      unknownBoundaryRecords: analysis.unknownBoundaryRecords,
      before: { prompts: bundle.prompts.prompts.length, answers: bundle.answers.answers.length },
      backupDir,
      startedAt,
      status: "pending",
    };
    existingManifest.entries.push(entry);
    await saveManifest(existingManifest, startedAt);
    try {
      const syncReport = await syncHistory(storage, tab.id, thread, { mode: "merge" });
      const afterBundle = await storage.readTab(tab.id);
      const sourceHashAfter = await hashFile(source);
      if (sourceHashAfter !== sourceHash) throw new Error("CODEX_ROLLOUT_CHANGED_DURING_MIGRATION");
      const completedAt = new Date().toISOString();
      Object.assign(entry, {
        after: { prompts: afterBundle.prompts.prompts.length, answers: afterBundle.answers.answers.length },
        syncReport,
        sourceHashAfter,
        completedAt,
        status: "applied",
      });
      await saveManifest(existingManifest, completedAt);
      Object.assign(item, { status: "applied", before: entry.before, after: entry.after, syncReport });
    } catch (error) {
      const failedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      Object.assign(entry, { status: "failed", failedAt, error: message });
      await saveManifest(existingManifest, failedAt);
      Object.assign(item, { status: "failed", error: message, rollback: `--rollback ${tab.id}` });
      process.exitCode = 1;
    }
  }

  process.stdout.write(`${JSON.stringify({
    migrationId: MIGRATION_ID,
    mode: args.apply ? "apply" : "dry-run",
    rootDir,
    cliVersion,
    parserVersion: PARSER_VERSION,
    tabs: report,
  }, null, 2)}\n`);
}

async function backupTab(tabId, backupDir) {
  await fs.mkdir(backupDir, { recursive: true });
  for (const source of [storage.tabPath(tabId), storage.promptPath(tabId), storage.answerPath(tabId), storage.runtimePath(tabId)]) {
    const target = path.join(backupDir, path.basename(source));
    try { await fs.access(target); }
    catch { await fs.copyFile(source, target); }
  }
}

async function saveManifest(manifest, updatedAt) {
  manifest.parserVersion = PARSER_VERSION;
  manifest.updatedAt = updatedAt;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFileAtomicWithRetry(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function rollbackTab(tabId) {
  const manifest = await readJson(manifestPath, null);
  if (!manifest) throw new Error(`MIGRATION_MANIFEST_NOT_FOUND:${manifestPath}`);
  const entry = [...manifest.entries].reverse().find((candidate) => candidate.tabId === tabId
    && (candidate.status === "applied" || candidate.status === "pending" || candidate.status === "failed"));
  if (!entry) throw new Error(`MIGRATION_BACKUP_NOT_FOUND:${tabId}`);
  const runtime = await storage.readRuntime(tabId);
  if (["starting", "running"].includes(runtime.terminal.state) || runtime.runner.activePromptId || runtime.runner.activeTurnId) {
    throw new Error(`TAB_ACTIVE:${tabId}`);
  }
  for (const name of ["tab.json", "prompt-list.json", "final-answers.json", "runtime.json"]) {
    const source = path.join(entry.backupDir, name);
    const target = path.join(storage.tabDir(tabId), name);
    await writeFileAtomicWithRetry(target, await fs.readFile(source, "utf8"));
  }
  entry.status = "rolled-back";
  entry.rolledBackAt = new Date().toISOString();
  manifest.updatedAt = entry.rolledBackAt;
  await writeFileAtomicWithRetry(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ migrationId: MIGRATION_ID, status: "rolled-back", tabId, backupDir: entry.backupDir }, null, 2)}\n`);
}

async function analyzeRollout(file) {
  const hash = createHash("sha256");
  const boundaryIds = new Set();
  let paginated = 0;
  let legacy = 0;
  let unknownBoundaryRecords = 0;
  let bytes = 0;
  let carry = "";
  const decoder = new StringDecoder("utf8");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
    const text = carry + decoder.write(chunk);
    const lines = text.split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) inspectLine(line);
  }
  carry += decoder.end();
  if (carry.trim()) inspectLine(carry);
  return {
    sourceHash: hash.digest("hex"),
    bytes,
    shape: paginated && legacy ? "mixed" : paginated ? "paginated" : legacy ? "legacy" : "boundary-only",
    boundaryTurns: boundaryIds.size,
    unknownBoundaryRecords,
  };

  function inspectLine(line) {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    const payload = record?.payload;
    const type = String(payload?.type ?? "");
    if (type === "item_completed") paginated += 1;
    if (record?.type === "response_item" && type === "message") legacy += 1;
    if (!["task_started", "task_complete", "turn_aborted", "turn_failed"].includes(type)) return;
    const turnId = String(payload?.turn_id ?? payload?.turnId ?? "");
    if (turnId) boundaryIds.add(turnId);
    else unknownBoundaryRecords += 1;
  }
}

async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function codexVersion() {
  try {
    const command = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "codex";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "codex --version"] : ["--version"];
    return String((await execFileAsync(command, args, { windowsHide: true })).stdout).trim() || null;
  } catch { return null; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function parseArgs(values) {
  const result = { apply: false, root: null, tab: null, rollback: null };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--apply") result.apply = true;
    else if (value === "--root") result.root = values[++index] ?? null;
    else if (value === "--tab") result.tab = values[++index] ?? null;
    else if (value === "--rollback") result.rollback = values[++index] ?? null;
    else throw new Error(`UNKNOWN_ARGUMENT:${value}`);
  }
  return result;
}
