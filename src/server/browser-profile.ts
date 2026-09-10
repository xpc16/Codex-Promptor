import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Borrowing the sign-in from the browser you actually use -- as far as that
 * goes, which is not far.
 *
 * Measured on Windows with Chrome running: the cookie database is held with an
 * exclusive lock and `copyFile` returns EBUSY, so only `Local State` comes
 * across and the copy is signed out. Even with the browser closed, Chrome 127
 * and later bind the cookie key to the browser itself, so a copy is not
 * guaranteed to decrypt.
 *
 * So this is best-effort and honest about it: it reports which files it
 * actually got, and the reliable path is signing in once inside Promptor's own
 * window, which then lasts. Set CODEX_PROMPTOR_BROWSER_PROFILE to share the
 * real directory instead -- and then only one of Promptor and that browser may
 * be running.
 */

export type ProfileSource = { userDataDir: string; channel: "chrome" | "msedge" };

/** Where Chrome and Edge keep their profiles on Windows, most preferred first. */
export function candidateProfileSources(env: NodeJS.ProcessEnv = process.env): ProfileSource[] {
  const local = env.LOCALAPPDATA;
  if (!local) return [];
  return [
    { userDataDir: path.join(local, "Google", "Chrome", "User Data"), channel: "chrome" },
    { userDataDir: path.join(local, "Microsoft", "Edge", "User Data"), channel: "msedge" },
  ];
}

/**
 * The files that carry a sign-in, and nothing else.
 *
 * `Local State` holds the key the cookie values are encrypted with; without it
 * the cookies copy across as unreadable bytes. Chrome moved the cookie
 * database under `Network/` at some point and both layouts are still in the
 * wild, so both are tried.
 *
 * Deliberately not copied: preferences, history, extensions, saved passwords,
 * payment methods. The sign-in is what is needed; the rest is not.
 */
export const PROFILE_FILES: readonly string[] = [
  "Local State",
  path.join("Default", "Network", "Cookies"),
  path.join("Default", "Cookies"),
];

export type SeedResult = {
  seeded: boolean;
  from: string | null;
  copied: string[];
  /** True only when a cookie database actually came across, not just the key. */
  carriedSignIn: boolean;
  reason?: string;
};

/**
 * Copy the sign-in into Promptor's profile, if it does not have one yet.
 *
 * Copying a database the browser has open can read it mid-write. That is why
 * this is best-effort per file and why a failed sign-in has a plain remedy:
 * sign in inside the window once, and it persists here from then on.
 */
export async function seedProfile(
  target: string,
  sources: readonly ProfileSource[],
  options: { force?: boolean } = {},
): Promise<SeedResult> {
  if (!options.force && await hasCookies(target)) {
    return { seeded: false, from: null, copied: [], carriedSignIn: false, reason: "ALREADY_SEEDED" };
  }
  for (const source of sources) {
    if (!await exists(path.join(source.userDataDir, "Local State"))) continue;
    const copied: string[] = [];
    for (const relative of PROFILE_FILES) {
      const from = path.join(source.userDataDir, relative);
      if (!await exists(from)) continue;
      const to = path.join(target, relative);
      try {
        await fs.mkdir(path.dirname(to), { recursive: true });
        await fs.copyFile(from, to);
        copied.push(relative);
      } catch { /* a locked file is not a reason to abandon the rest */ }
    }
    // Only a cookie database is a sign-in. `Local State` on its own is the key
    // to a lock with nothing behind it, which is what a running browser leaves.
    const carriedSignIn = copied.some((relative) => relative.endsWith("Cookies"));
    if (copied.length) {
      return { seeded: true, from: source.userDataDir, copied, carriedSignIn, reason: carriedSignIn ? undefined : "COOKIES_LOCKED" };
    }
  }
  return { seeded: false, from: null, copied: [], carriedSignIn: false, reason: "NO_SOURCE_PROFILE" };
}

async function hasCookies(userDataDir: string): Promise<boolean> {
  for (const relative of PROFILE_FILES.slice(1)) {
    if (await exists(path.join(userDataDir, relative))) return true;
  }
  return false;
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Chrome's refusal to open a directory another Chrome already holds. */
export function profileInUse(message: string): boolean {
  return /ProcessSingleton|profile appears to be in use|SingletonLock|cannot create default profile/i.test(message);
}
