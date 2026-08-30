import { promises as fs } from "node:fs";
import path from "node:path";

export const REMOTE_ACCESS_CONFIG = path.join("data", "private", "remote-access.json");

function normalizedHost(value: string, source: string): string {
  const input = value.trim().toLowerCase();
  if (!input) throw new Error(`${source} contains an empty trusted host.`);
  try {
    const parsed = new URL(`https://${input}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || !parsed.hostname) {
      throw new Error("not a host");
    }
    return parsed.host.toLowerCase();
  } catch {
    throw new Error(`${source} contains an invalid trusted host: ${value}`);
  }
}

function configuredHosts(values: unknown, source: string): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error(`${source} must contain a string array named \"trustedHosts\".`);
  }
  return values.map((value) => normalizedHost(value as string, source));
}

/**
 * Remote host names are local deployment data, not repository settings. Keep
 * them beside the existing private document key so a normal `node dist/...`
 * launch and `start.ps1` behave identically. The environment variable remains
 * supported and is merged with the file for service-based deployments.
 */
export async function loadTrustedBrowserHosts(rootDir: string, environmentValue = ""): Promise<string[]> {
  const environmentHosts = environmentValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => normalizedHost(value, "CODEX_PROMPTOR_TRUSTED_HOSTS"));
  const configPath = path.join(rootDir, REMOTE_ACCESS_CONFIG);
  let fileHosts: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as { trustedHosts?: unknown };
    fileHosts = configuredHosts(parsed?.trustedHosts, configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...new Set([...environmentHosts, ...fileHosts])];
}
