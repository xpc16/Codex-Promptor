/**
 * Does the installed Codex still speak what this app depends on?
 *
 * None of it is a public API. The App Server's JSON-RPC surface, the CLI flags
 * the TUI is launched with, and the rollout file format are all Codex
 * internals, and an upgrade is free to change any of them. Worse, most of the
 * breakage would be silent: history reads fall back and swallow failures, so a
 * conversation loses its past rather than reporting an error.
 *
 * Run this after upgrading Codex, before trusting a conversation to it:
 *
 *   node scripts/check-codex-compat.mjs
 *
 * Exit code 0 means everything the app needs answered. Non-zero lists what did
 * not, and which part of the app depends on it.
 */
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { createReadStream, promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { buildCodexHookOverride } from "../src/server/codex-tui.ts";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";
const command = await resolveCodexExecutable();
const commandNeedsShell = isWindows && /\.(?:cmd|bat)$/i.test(command);
const findings = [];
const note = (ok, what, detail, usedBy) => {
  findings.push({ ok, what, detail, usedBy });
  console.log(`${ok ? "  ok  " : " FAIL "} ${what.padEnd(26)} ${detail}`);
};

const freePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

// ---------------------------------------------------------------- the binary
console.log("\nCodex CLI");
let version = "unknown";
try {
  const result = await execFileAsync(command, ["--version"], { windowsHide: true, shell: commandNeedsShell });
  version = String(result.stdout).trim();
  note(true, "codex --version", version, "AppServerManager.version()");
} catch (error) {
  note(false, "codex --version", String(error?.message ?? error), "everything");
}

// The TUI is launched with these; a renamed or dropped flag means no terminal.
console.log("\nCLI flags the terminal is launched with");
let help = "";
try {
  const result = await execFileAsync(command, ["--help"], { windowsHide: true, shell: commandNeedsShell });
  help = `${result.stdout}${result.stderr}`;
} catch (error) { help = String(error?.stdout ?? "") + String(error?.stderr ?? ""); }
for (const flag of ["--remote", "--no-alt-screen", "-C", "--dangerously-bypass-hook-trust"]) {
  note(help.includes(flag), `flag ${flag}`, help.includes(flag) ? "present" : "not in --help", "pty.ts buildCodexCommand");
}
note(/\bresume\b/.test(help), "subcommand resume", /\bresume\b/.test(help) ? "present" : "missing", "reopening a conversation");
note(/\bapp-server\b/.test(help), "subcommand app-server", /\bapp-server\b/.test(help) ? "present" : "missing", "the whole RPC path");

const hookOverride = buildCodexHookOverride(path.join(process.cwd(), "scripts", "codex-hook.mjs"));
try {
  const result = await execFileAsync(command, ["-c", hookOverride, "--version"], { windowsHide: true, shell: commandNeedsShell });
  note(result.stdout.includes("codex-cli"), "per-run hook TOML", String(result.stdout).trim(), "native PTY/hooks transport");
} catch (error) {
  note(false, "per-run hook TOML", String(error?.stderr ?? error?.message ?? error), "native PTY/hooks transport");
}

// ----------------------------------------------------------- the app server
console.log("\nApp Server");
const port = await freePort();
const url = `ws://127.0.0.1:${port}`;
const child = spawn(command, ["app-server", "--listen", url], {
  cwd: process.cwd(), windowsHide: true, shell: commandNeedsShell, stdio: ["ignore", "pipe", "pipe"],
});
let said = "";
child.stdout?.on("data", (chunk) => { said += chunk; });
child.stderr?.on("data", (chunk) => { said += chunk; });

const ready = await (async () => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (response.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
})();
note(ready, "GET /readyz", ready ? "responded" : "never became ready in 20s", "AppServerManager.start()");

if (ready) {
  const socket = new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });
  await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });

  let nextId = 1;
  const pending = new Map();
  socket.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.id === undefined) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    entry(message);
  });
  const call = (method, params, timeoutMs = 8_000) => new Promise((resolve) => {
    const id = nextId += 1;
    const timer = setTimeout(() => { pending.delete(id); resolve({ timedOut: true }); }, timeoutMs);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    socket.send(JSON.stringify({ id, method, params }));
  });

  const handshake = await call("initialize", { clientInfo: { name: "codex-promptor-compat", version: "0" } }, 8_000);
  note(!handshake.timedOut && !handshake.error, "initialize", handshake.error ? JSON.stringify(handshake.error) : "accepted", "connecting at all");
  socket.send(JSON.stringify({ method: "initialized", params: {} }));

  /**
   * A JSON-RPC server answers -32601 for a method it does not have. Anything
   * else -- a result, or a complaint about the arguments -- means the method is
   * still there, which is all this is asking.
   */
  const METHODS = [
    ["thread/loaded/list", { limit: 1 }, "which threads are loaded"],
    ["thread/read", { threadId: "00000000-0000-0000-0000-000000000000", includeTurns: false }, "history sync, waitForTurn"],
    ["thread/resume", { threadId: "00000000-0000-0000-0000-000000000000", cwd: process.cwd() }, "subscribing to a conversation"],
    ["thread/start", { cwd: process.cwd(), serviceName: "codex-promptor-compat" }, "new conversations"],
    ["thread/unsubscribe", { threadId: "00000000-0000-0000-0000-000000000000" }, "releasing threads on shutdown"],
    ["turn/start", { threadId: "00000000-0000-0000-0000-000000000000", clientUserMessageId: "compat", cwd: process.cwd(), input: [] }, "dispatching a queued prompt"],
    ["turn/steer", { threadId: "00000000-0000-0000-0000-000000000000", expectedTurnId: "none", clientUserMessageId: "compat", input: [] }, "inserting a prompt into a running turn"],
    ["turn/interrupt", { threadId: "00000000-0000-0000-0000-000000000000", turnId: "none" }, "the interrupt button"],
  ];
  console.log("\nRPC methods");
  for (const [method, params, usedBy] of METHODS) {
    const reply = await call(method, params);
    if (reply.timedOut) { note(false, method, "no reply in 8s", usedBy); continue; }
    const code = reply.error?.code;
    const missing = code === -32601;
    note(!missing, method, missing ? `method not found (${JSON.stringify(reply.error)})` : "recognized", usedBy);
  }
  socket.close();
}
child.kill();

// -------------------------------------------------------- the rollout format
console.log("\nRollout format");
const sessions = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
const rollouts = [];
const walk = async (dir) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".jsonl")) rollouts.push(full);
  }
};
await walk(sessions);
note(rollouts.length > 0, "sessions directory", rollouts.length ? `${rollouts.length} rollouts under ${sessions}` : `nothing under ${sessions}`, "all Codex history");

if (rollouts.length) {
  const stats = await Promise.all(rollouts.map(async (file) => ({ file, at: (await fs.stat(file)).mtimeMs })));
  const newest = stats.sort((a, b) => b.at - a.at)[0].file;
  const seen = new Set();
  let meta = null, lines = 0, boundaryRecords = 0, boundaryRecordsWithIds = 0;
  let paginatedContent = false, legacyContent = false;
  const reader = createInterface({ input: createReadStream(newest, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    lines += 1;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (lines === 1) meta = record?.payload ?? null;
    const type = String(record?.payload?.type ?? "");
    if (type) seen.add(type);
    if (type === "item_completed") paginatedContent = true;
    if (record?.type === "response_item" && type === "message") legacyContent = true;
    if (["task_started", "task_complete", "turn_aborted", "turn_failed"].includes(type)) {
      boundaryRecords += 1;
      if (record?.payload?.turn_id || record?.payload?.turnId) boundaryRecordsWithIds += 1;
    }
    if (lines > 60_000) break;
  }
  reader.close();
  const mode = String(meta?.history_mode ?? "(absent)");
  console.log(`  newest rollout: ${path.basename(newest)} (${lines} records, ${meta?.cli_version ?? "?"}, history_mode ${mode})`);

  // The parser builds a turn out of exactly these; without them a conversation
  // reads as empty, and syncHistory deletes records for turns it is not shown.
  for (const type of ["task_started", "task_complete"]) {
    note(seen.has(type), `record ${type}`, seen.has(type) ? "present" : "absent from the newest rollout", "codex-history.ts createRolloutParser");
  }
  // Both currently observed content families are supported. Unknown content
  // shapes must fail closed rather than be mistaken for an empty conversation.
  note(
    paginatedContent || legacyContent,
    "recognized content shape",
    paginatedContent ? "paginated item_completed" : legacyContent ? "legacy response_item message" : "neither known shape appeared",
    "prompt and answer reconciliation",
  );
  note(
    boundaryRecords > 0 && boundaryRecords === boundaryRecordsWithIds,
    "turn boundary ids",
    `${boundaryRecordsWithIds}/${boundaryRecords} recognized boundaries carry turn_id`,
    "low-frequency completion reconciliation",
  );
  const hasIds = meta && (meta.session_id || meta.id);
  note(Boolean(hasIds), "session_meta ids", hasIds ? "session_id/id present" : "missing", "matching a rollout to a conversation");
  // Only forked threads carry this, so its absence here is not a failure.
  console.log(`  ${meta?.history_base ? "ok  " : "note"} session_meta.history_base ${meta?.history_base ? "present (this thread is a fork)" : "absent (this thread is not a fork) - only forks carry it"}`);
}

// ------------------------------------------------------------------ verdict
const failed = findings.filter((finding) => !finding.ok);
console.log(`\n${"-".repeat(72)}`);
if (!failed.length) {
  console.log(`Codex ${version}: everything this app depends on is present.`);
  process.exitCode = 0;
} else {
  console.log(`Codex ${version}: ${failed.length} of ${findings.length} checks failed.`);
  for (const finding of failed) console.log(`  ${finding.what}  ->  breaks: ${finding.usedBy}`);
  if (said.trim()) console.log(`\nApp Server said:\n${said.trim().split("\n").slice(-10).map((line) => `  ${line}`).join("\n")}`);
  process.exitCode = 1;
}

async function resolveCodexExecutable() {
  if (!isWindows) return "codex";
  try {
    const where = await execFileAsync("where.exe", ["codex.cmd"], { windowsHide: true });
    const shim = String(where.stdout).split(/\r?\n/).find(Boolean);
    if (!shim) return "codex.cmd";
    const packageModules = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "node_modules");
    const stack = [packageModules];
    while (stack.length) {
      const directory = stack.pop();
      for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === "codex.exe") return full;
      }
    }
  } catch { /* fall back to the npm shim */ }
  return "codex.cmd";
}
