// Codex command-hook bridge. Hooks are a fast observability path only; the
// rollout remains the reconciliation authority when this best-effort POST is
// delayed or lost.
const hookUrl = process.env.CODEX_PROMPTOR_CODEX_HOOK_URL;
const hookSecret = process.env.CODEX_PROMPTOR_HOOK_SECRET;
const eventName = process.argv[2] ?? "";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8 * 1024 * 1024) process.exit(0);
}

if (!hookUrl || !hookSecret || !eventName) process.exit(0);

let payload = {};
try { payload = input.trim() ? JSON.parse(input) : {}; }
catch { payload = {}; }

try {
  await fetch(hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hookSecret}` },
    body: JSON.stringify({ ...payload, hook_event_name: payload.hook_event_name ?? eventName }),
    signal: AbortSignal.timeout(5_000),
  });
} catch {
  // A missing Promptor must never block or alter an independent Codex TUI.
}
