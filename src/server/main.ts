import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "./app.js";
import { appendRestoreTimings } from "./restore-timing.js";

const rootDir = path.resolve(process.env.CODEX_PROMPTOR_ROOT ?? process.cwd());
const port = Number(process.env.PORT ?? 4317);

const app = await createApp(rootDir);
let shuttingDown = false;
const shutdown = async (reason?: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.log(reason);
  await app.promptor.close();
  await app.close();
  process.exit(0);
};
if (process.env.CODEX_PROMPTOR_AUTO_EXIT !== "0") {
  app.promptor.ui.on("idle", () => void shutdown("Last browser page closed; Codex Promptor stopped."));
}

await app.listen({ host: "127.0.0.1", port });
const restorePromise = app.promptor.restoreOpenSessions();
const address = app.server.address();
const actualPort = typeof address === "object" && address ? address.port : port;
const url = `http://127.0.0.1:${actualPort}/`;
console.log(`Codex Promptor ready: ${url}`);
console.log(`Data directory: ${app.promptor.storage.dataDir}`);
void restorePromise.then(async ({ restored, failed, timings }) => {
  if (restored.length) console.log(`Restored ${restored.length} previously open coding-agent conversation(s).`);
  for (const line of timings) console.log(line);
  for (const item of failed) console.error(`Failed to restore tab ${item.tabId} [${item.code}]: ${item.message}`);
  await appendRestoreTimings(path.join(app.promptor.storage.dataDir, "restore-timings.log"), timings);
  // After the restore, never alongside it: both walk the same rollout
  // directory, and the conversations somebody actually has open come first.
  const summary = await app.promptor.importDiscoveredSessions();
  if (summary.imported) console.log(`Imported ${summary.imported} past conversation(s) into the "Imported" group; open one to start its session.`);
  if (summary.failed) console.error(`${summary.failed} past conversation(s) could not be read and were left alone.`);
});
if (process.platform === "win32" && process.env.CODEX_PROMPTOR_OPEN !== "0") {
  spawn("cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
