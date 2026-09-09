import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentProcessLaunch } from "./pty.js";
import { resolveCodexTuiLaunch } from "./codex-tui.js";

/**
 * "Installed" and "on this process's PATH" are different questions, and the
 * adapter used to answer only the second one. npm's global bin directory is
 * not always on PATH, and a process keeps whatever PATH it launched with, so
 * a codex installed after the app started is invisible to `where.exe`.
 */

const LAUNCH: AgentProcessLaunch = { executable: "codex", args: ["--no-alt-screen"] };

describe.skipIf(process.platform !== "win32")("finding the codex binary", () => {
  let root: string;
  let npmDir: string;
  const previous = {
    path: process.env.PATH,
    appData: process.env.APPDATA,
    configured: process.env.CODEX_PROMPTOR_CODEX_EXECUTABLE,
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-codex-bin-"));
    npmDir = path.join(root, "npm");
    await mkdir(npmDir, { recursive: true });
    // A PATH with where.exe on it and no codex anywhere, which is the shape of
    // the machine this exists for.
    process.env.PATH = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    process.env.APPDATA = root;
    delete process.env.CODEX_PROMPTOR_CODEX_EXECUTABLE;
  });

  afterEach(async () => {
    for (const [key, value] of [["PATH", previous.path], ["APPDATA", previous.appData], ["CODEX_PROMPTOR_CODEX_EXECUTABLE", previous.configured]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  /** What `npm i -g @openai/codex` leaves behind: a batch shim beside the package. */
  const installShim = async () => {
    await writeFile(path.join(npmDir, "codex.cmd"), "@echo off\r\n", "utf8");
    const binDir = path.join(npmDir, "node_modules", "@openai", "codex", "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, "codex.js"), "// entry point\n", "utf8");
  };

  it("finds an npm global install that PATH says nothing about", async () => {
    await installShim();
    const resolved = await resolveCodexTuiLaunch(LAUNCH);
    // The shim is a batch file; handing it to an exact-argv launch would put a
    // shell in the middle of the arguments, so it resolves to the entry point.
    expect(resolved.executable).toBe(process.execPath);
    expect(resolved.args[0]).toBe(path.join(npmDir, "node_modules", "@openai", "codex", "bin", "codex.js"));
    expect(resolved.args.slice(1)).toEqual(LAUNCH.args);
  });

  it("prefers a real binary to a shim when both are there", async () => {
    await installShim();
    await writeFile(path.join(npmDir, "codex.exe"), "MZ", "utf8");
    const resolved = await resolveCodexTuiLaunch(LAUNCH);
    expect(resolved.executable).toBe(path.join(npmDir, "codex.exe"));
    expect(resolved.args).toEqual(LAUNCH.args);
  });

  it("ignores a shim whose package is not beside it", async () => {
    // A leftover shim from an uninstall points at nothing. Launching it would
    // fail later and less clearly than saying so here.
    await writeFile(path.join(npmDir, "codex.cmd"), "@echo off\r\n", "utf8");
    await expect(resolveCodexTuiLaunch(LAUNCH)).rejects.toThrow("CODEX_NATIVE_EXECUTABLE_NOT_FOUND");
  });

  it("still says so plainly when codex is nowhere", async () => {
    await expect(resolveCodexTuiLaunch(LAUNCH)).rejects.toThrow("CODEX_NATIVE_EXECUTABLE_NOT_FOUND");
  });

  it("takes a configured path over any of the searching", async () => {
    process.env.CODEX_PROMPTOR_CODEX_EXECUTABLE = "D:\\elsewhere\\codex.exe";
    await installShim();
    expect((await resolveCodexTuiLaunch(LAUNCH)).executable).toBe("D:\\elsewhere\\codex.exe");
  });
});
