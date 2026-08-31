import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("PowerShell exact-argv agent launcher", () => {
  it.runIf(process.platform === "win32")("preserves spaces, backslashes and embedded TOML quotes", async () => {
    const argument = 'hooks={SessionStart=[{hooks=[{type="command",command="C:\\\\Program Files\\\\node.exe hook.mjs"}]}]}';
    const exitMarker = "__PROMPTOR_ARGV_TEST_EXIT__:";
    const spec = Buffer.from(JSON.stringify({
      executable: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", argument],
      cwd: process.cwd(),
      theme: "light",
      exitMarker,
      nodePath: process.execPath,
    }), "utf8").toString("base64");
    const result = await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(process.cwd(), "scripts", "launch-agent.ps1"),
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_PROMPTOR_AGENT_SPEC_BASE64: spec },
      windowsHide: true,
    });
    expect(result.stdout).toContain(argument);
    expect(result.stdout).toContain(`${exitMarker}0`);
  });
});
