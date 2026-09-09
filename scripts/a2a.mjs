#!/usr/bin/env node
/**
 * Promptor A2A call helper.
 *
 * Thin on purpose: it finds the hook lease this CLI was launched with, turns
 * its `/hooks/` URL into the `/a2a/` one, and sets the bearer header. There is
 * no SDK and no state -- the server owns identity, budget and lifecycle.
 *
 * The secret is read from the environment and never printed, so it cannot
 * reach a prompt, a final answer, a command line or a log.
 *
 *   node scripts/a2a.mjs list   --context <attemptId>
 *   node scripts/a2a.mjs read   --context <id> --to <tabId> [--limit 3]
 *   node scripts/a2a.mjs status --context <id> [--to <tabId>]
 *   node scripts/a2a.mjs send   --context <id> --to <tabId> --text "..." [--role worker]
 *   node scripts/a2a.mjs finish --context <id> [--reason completed]
 */
import { createHash } from "node:crypto";

const OPS = new Set(["list", "read", "status", "send", "finish"]);
const WRITE_OPS = new Set(["send", "finish"]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const op = argv[0];
  if (!op || !OPS.has(op)) fail(`用法: node scripts/a2a.mjs <${[...OPS].join("|")}> --context <attemptId> [...]`);
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`无法识别的参数 ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`${token} 需要一个值`);
    flags[key] = value;
    index += 1;
  }
  return { op, flags };
}

/** The hook URL of whichever provider launched this process, rewritten to the A2A path. */
function endpoint() {
  for (const name of ["CODEX", "CLAUDE", "CURSOR"]) {
    const url = process.env[`CODEX_PROMPTOR_${name}_HOOK_URL`];
    if (url && url.includes("/hooks/")) return url.replace("/hooks/", "/a2a/");
  }
  return null;
}

const { op, flags } = parseArgs(process.argv.slice(2));
const url = endpoint();
const secret = process.env.CODEX_PROMPTOR_HOOK_SECRET;
if (!url || !secret) {
  fail("这个进程没有 Promptor 的 Hook 租约，不支持 A2A。（需要由 Promptor 打开的 Codex / Claude Code / Cursor 会话。）");
}
const contextId = flags.context ?? flags.contextId;
if (!contextId) fail("缺少 --context <attemptId>：用派发说明里给出的那个值。");

const body = { op, contextId };
if (flags.to) body.to = flags.to;
if (flags.text !== undefined) body.text = flags.text;
if (flags.limit !== undefined) body.limit = Number(flags.limit);
if (flags.promptId) body.promptId = flags.promptId;
if (flags.role) body.targetRole = flags.role;
if (flags.reason) body.reason = flags.reason;
if (WRITE_OPS.has(op)) {
  // A stable default: re-running the identical command is a retry of the same
  // request, not a second one. Pass --request-id to control it explicitly.
  body.requestId = flags["request-id"]
    ?? flags.requestId
    ?? createHash("sha1").update(JSON.stringify([op, contextId, body.to ?? "", body.text ?? "", body.reason ?? ""])).digest("hex").slice(0, 24);
}

let response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
} catch (error) {
  fail(`调用 Promptor 失败：${error instanceof Error ? error.message : String(error)}`);
}

const text = await response.text();
let parsed;
try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
// Both outcomes go to stdout as JSON: a refusal carries the limits and the
// advice the agent needs in order to wrap up, so it must not be swallowed.
process.stdout.write(`${JSON.stringify(parsed.data ?? parsed, null, 2)}\n`);
process.exit(response.ok ? 0 : 1);
