#!/usr/bin/env node
import { spawn } from "node:child_process";

// Windows PowerShell 5.1 re-quotes native argv arrays and corrupts embedded
// TOML/JSON quotes. This tiny child inherits the existing ConPTY handles while
// Node passes each argument to CreateProcess with its proven argv quoting.
let spec;
try {
  const encoded = process.env.CODEX_PROMPTOR_AGENT_SPEC_BASE64;
  if (!encoded) throw new Error("CODEX_PROMPTOR_AGENT_SPEC_MISSING");
  spec = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!spec?.executable || !Array.isArray(spec?.args)) throw new Error("CODEX_PROMPTOR_AGENT_SPEC_INVALID");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

if (spec) {
  const child = spawn(String(spec.executable), spec.args.map(String), {
    cwd: String(spec.cwd || process.cwd()),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve(1);
    });
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
}
