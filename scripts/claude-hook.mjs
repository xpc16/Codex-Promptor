// Claude Code command-hook bridge. SessionStart does not support Claude's
// native HTTP hook type, so all Promptor lifecycle events use this silent
// command hook and post to the tab-private loopback endpoint instead.
const hookUrl = process.env.CODEX_PROMPTOR_CLAUDE_HOOK_URL;
const hookSecret = process.env.CODEX_PROMPTOR_HOOK_SECRET;
const eventName = process.argv[2] ?? "";

// Claude's background-agent daemon inherits the foreground CLI's explicit
// --settings file and hook environment. Those hooks describe a different PTY:
// letting their SessionStart reach Promptor makes the visible tab follow the
// background fork and then fail to resume its still-active writer. Claude sets
// this variable on daemon workers (including `none` isolation); filter every
// event at the bridge so background turns cannot affect the foreground tab or
// consume any local HTTP traffic. Foreground /resume, /clear and /branch do not
// carry this marker and continue to synchronize normally.
if (Object.prototype.hasOwnProperty.call(process.env, "CLAUDE_BG_ISOLATION")) process.exit(0);

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
  // Observation must never block or add text to UserPromptSubmit/SessionStart.
}
