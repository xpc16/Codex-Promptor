import path from "node:path";
import { spawn } from "node:child_process";
import { createApp } from "./app.js";

const rootDir = path.resolve(process.env.CODEX_PROMPTOR_ROOT ?? process.cwd());
const port = Number(process.env.PORT ?? 4317);

const app = await createApp(rootDir);
await app.listen({ host: "127.0.0.1", port });
const address = app.server.address();
const actualPort = typeof address === "object" && address ? address.port : port;
console.log(`Codex Promptor ready: http://127.0.0.1:${actualPort}/?token=${app.promptor.token}`);
console.log(`Data directory: ${app.promptor.storage.dataDir}`);
if (process.platform === "win32" && process.env.CODEX_PROMPTOR_OPEN !== "0") {
  const url = `http://127.0.0.1:${actualPort}/?token=${app.promptor.token}`;
  spawn("cmd.exe", ["/d", "/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
}

const shutdown = async () => {
  await app.promptor.close();
  await app.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
