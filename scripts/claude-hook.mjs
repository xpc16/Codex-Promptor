// Claude Code command-hook bridge. SessionStart does not support Claude's
// native HTTP hook type, so all Promptor lifecycle events use this silent
// command hook and post to the tab-private loopback endpoint instead.
const hookUrl = process.env.CODEX_PROMPTOR_CLAUDE_HOOK_URL;
const eventName = process.argv[2] ?? "";

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8 * 1024 * 1024) process.exit(0);
}

if (!hookUrl || !eventName) process.exit(0);

let payload = {};
try { payload = input.trim() ? JSON.parse(input) : {}; }
catch { payload = {}; }

try {
  await fetch(hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, hook_event_name: payload.hook_event_name ?? eventName }),
    signal: AbortSignal.timeout(5_000),
  });
} catch {
  // Observation must never block or add text to UserPromptSubmit/SessionStart.
}
