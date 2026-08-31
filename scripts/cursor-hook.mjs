// Promptor's Cursor hook dispatcher. It is registered once in ~/.cursor/hooks.json
// and becomes a no-op for every Cursor process that was not launched by Promptor.
const hookUrl = process.env.CODEX_PROMPTOR_CURSOR_HOOK_URL;
const hookSecret = process.env.CODEX_PROMPTOR_HOOK_SECRET;
const eventName = process.argv[2] ?? "";
const transcriptPath = process.env.CURSOR_TRANSCRIPT_PATH;

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 8 * 1024 * 1024) process.exit(0);
}

if (!hookUrl || !hookSecret || !eventName) {
  process.stdout.write("{}\n");
  process.exit(0);
}

let payload = {};
try { payload = input.trim() ? JSON.parse(input) : {}; }
catch { payload = {}; }

try {
  const response = await fetch(hookUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${hookSecret}` },
    body: JSON.stringify({
      ...payload,
      hook_event_name: payload.hook_event_name ?? eventName,
      transcript_path: payload.transcript_path ?? transcriptPath,
    }),
    signal: AbortSignal.timeout(8_000),
  });
  const output = response.ok ? await response.text() : "";
  process.stdout.write(`${output.trim() || "{}"}\n`);
} catch {
  // Cursor hooks are observability-only here. A stopped Promptor must never
  // block or change the user's independent Cursor CLI sessions.
  process.stdout.write("{}\n");
}
