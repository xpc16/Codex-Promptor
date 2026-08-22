import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "./app.js";

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
const address = app.server.address();
const actualPort = typeof address === "object" && address ? address.port : port;
const url = `http://127.0.0.1:${actualPort}/`;
console.log(`Codex Promptor ready: ${url}`);
console.log(`Data directory: ${app.promptor.storage.dataDir}`);
if (process.platform === "win32" && process.env.CODEX_PROMPTOR_OPEN !== "0") {
  spawn("cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
