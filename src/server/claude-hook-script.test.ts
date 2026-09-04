import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Claude command-hook bridge", () => {
  it("forwards foreground hooks but drops hooks inherited by background agents", async () => {
    const received: unknown[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        received.push(JSON.parse(body));
        response.writeHead(204).end();
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    const hookUrl = `http://127.0.0.1:${address.port}/hook`;

    await runHook(hookUrl, false);
    expect(received).toEqual([expect.objectContaining({ hook_event_name: "SessionStart", session_id: "foreground-session" })]);

    await runHook(hookUrl, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
  });
});

async function runHook(hookUrl: string, background: boolean): Promise<void> {
  const env = { ...process.env };
  delete env.CLAUDE_BG_ISOLATION;
  Object.assign(env, {
    CODEX_PROMPTOR_CLAUDE_HOOK_URL: hookUrl,
    CODEX_PROMPTOR_HOOK_SECRET: "test-secret",
    ...(background ? { CLAUDE_BG_ISOLATION: "none" } : {}),
  });
  const child = spawn(process.execPath, [path.join(process.cwd(), "scripts", "claude-hook.mjs"), "SessionStart"], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  child.stdin.end(JSON.stringify({ session_id: "foreground-session", source: background ? "fork" : "resume" }));
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit") as [number | null];
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
}
