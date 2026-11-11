// Used by both launchers before building or starting. This must run with Node
// alone: tsx and every other package may still be missing after a git pull.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function dependencyIssue(root, manifest, lock) {
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ]);
  for (const name of names) {
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    if (!expected) throw new Error(`No locked version for ${name} in package-lock.json.`);
    let installed;
    try {
      installed = await readJson(path.join(root, "node_modules", name, "package.json"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return `${name} is missing or incomplete`;
      throw error;
    }
    if (installed.version !== expected) return `${name} does not match package-lock.json`;
  }
  return null;
}

function installDependencies(root) {
  return new Promise((resolve, reject) => {
    const windows = process.platform === "win32";
    const child = spawn(windows ? "npm.cmd" : "npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
      cwd: root,
      stdio: "inherit",
      shell: windows,
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`npm ci failed (${signal ?? code}). Close other Promptor instances if files are locked, then retry.`));
    });
  });
}

export async function ensureDependencies(root = process.cwd(), { install = installDependencies, log = console.log } = {}) {
  root = path.resolve(root);
  const [manifestText, lockText] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8"),
    readFile(path.join(root, "package-lock.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const lock = JSON.parse(lockText);
  // A different Node ABI or OS also needs fresh native modules (node-pty).
  // Normalize line endings so Windows and Unix checkouts agree.
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([process.platform, process.arch, process.versions.modules]))
    .update("\0").update(manifestText.replace(/\r\n/g, "\n"))
    .update("\0").update(lockText.replace(/\r\n/g, "\n"))
    .digest("hex");
  const marker = path.join(root, "node_modules", ".promptor-dependencies.json");
  let previous;
  try { previous = await readJson(marker); }
  catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (previous?.fingerprint === fingerprint && !await dependencyIssue(root, manifest, lock)) return false;

  // Invalidate before installing: a failed/partial installation must be retried
  // even if the user later switches back to the previous lockfile.
  await rm(marker, { force: true });
  log("Dependencies changed or are incomplete; running npm ci --include=dev...");
  await install(root);
  const issue = await dependencyIssue(root, manifest, lock);
  if (issue) throw new Error(`Dependency installation is incomplete: ${issue}. Run npm ci --include=dev and retry.`);
  await writeFile(marker, `${JSON.stringify({ fingerprint })}\n`, "utf8");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await ensureDependencies(); }
  catch (error) {
    console.error(`Cannot prepare dependencies: ${error.message}`);
    process.exitCode = 1;
  }
}
