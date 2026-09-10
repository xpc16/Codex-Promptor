import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROFILE_FILES, candidateProfileSources, profileInUse, seedProfile } from "./browser-profile.js";

/**
 * Borrowing a sign-in, and borrowing nothing else.
 *
 * The narrowness is the point: a fresh profile cannot get past the checks in
 * front of some sign-in pages, so the cookies have to come from the everyday
 * browser -- but history, saved passwords and extensions have no reason to
 * come with them.
 */

describe("seeding the profile", () => {
  let root: string;
  let source: string;
  let target: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "promptor-profile-"));
    source = path.join(root, "source");
    target = path.join(root, "target");
    await mkdir(path.join(source, "Default", "Network"), { recursive: true });
    await writeFile(path.join(source, "Local State"), "{\"os_crypt\":{\"encrypted_key\":\"k\"}}", "utf8");
    await writeFile(path.join(source, "Default", "Network", "Cookies"), "cookie-bytes", "utf8");
    // Things a browser profile also holds, and which must stay where they are.
    await writeFile(path.join(source, "Default", "History"), "browsing history", "utf8");
    await writeFile(path.join(source, "Default", "Login Data"), "saved passwords", "utf8");
    await writeFile(path.join(source, "Default", "Preferences"), "{}", "utf8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }).catch(() => undefined);
  });

  const sources = () => [{ userDataDir: source, channel: "chrome" as const }];

  it("copies the sign-in and nothing else", async () => {
    const result = await seedProfile(target, sources());
    expect(result).toMatchObject({ seeded: true, from: source, carriedSignIn: true });
    expect(await readFile(path.join(target, "Default", "Network", "Cookies"), "utf8")).toBe("cookie-bytes");
    // The key the cookie values are encrypted with, without which they are noise.
    expect(await readFile(path.join(target, "Local State"), "utf8")).toContain("encrypted_key");
    for (const unwanted of ["History", "Login Data", "Preferences"]) {
      await expect(readFile(path.join(target, "Default", unwanted), "utf8")).rejects.toThrow();
    }
  });

  it("does not copy over a profile that already has a sign-in", async () => {
    await seedProfile(target, sources());
    await writeFile(path.join(target, "Default", "Network", "Cookies"), "signed-in-here", "utf8");
    const again = await seedProfile(target, sources());
    expect(again).toMatchObject({ seeded: false, reason: "ALREADY_SEEDED" });
    // Signing in inside the window has to survive, or it would be undone every launch.
    expect(await readFile(path.join(target, "Default", "Network", "Cookies"), "utf8")).toBe("signed-in-here");
  });

  it("replaces it when asked, which is what an expired sign-in needs", async () => {
    await seedProfile(target, sources());
    await writeFile(path.join(target, "Default", "Network", "Cookies"), "stale", "utf8");
    await seedProfile(target, sources(), { force: true });
    expect(await readFile(path.join(target, "Default", "Network", "Cookies"), "utf8")).toBe("cookie-bytes");
  });

  it("says the sign-in did not come across when the cookie file was locked", async () => {
    // What a running Chrome actually leaves behind: the key, and nothing to
    // unlock. Reporting it as a successful borrow is how a signed-out window
    // came as a surprise.
    await rm(path.join(source, "Default", "Network"), { recursive: true, force: true });
    const result = await seedProfile(target, sources());
    expect(result).toMatchObject({ seeded: true, carriedSignIn: false, reason: "COOKIES_LOCKED" });
  });

  it("says so plainly when there is no browser to borrow from", async () => {
    const result = await seedProfile(target, [{ userDataDir: path.join(root, "nothing"), channel: "chrome" }]);
    expect(result).toMatchObject({ seeded: false, reason: "NO_SOURCE_PROFILE" });
  });

  it("also finds the older cookie location", async () => {
    await rm(path.join(source, "Default", "Network"), { recursive: true, force: true });
    await writeFile(path.join(source, "Default", "Cookies"), "older-layout", "utf8");
    await seedProfile(target, sources());
    expect(await readFile(path.join(target, "Default", "Cookies"), "utf8")).toBe("older-layout");
  });

  it("looks for Chrome before Edge, and only under this account", () => {
    const found = candidateProfileSources({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" } as NodeJS.ProcessEnv);
    expect(found.map((source) => source.channel)).toEqual(["chrome", "msedge"]);
    expect(found[0].userDataDir).toContain(path.join("Google", "Chrome", "User Data"));
    expect(candidateProfileSources({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("keeps the copied list to the sign-in files", () => {
    expect(PROFILE_FILES.some((file) => /History|Login Data|Bookmarks|Extension/i.test(file))).toBe(false);
  });

  it("recognises the refusal that means a browser already holds the directory", () => {
    expect(profileInUse("ProcessSingleton: failed to create SingletonLock")).toBe(true);
    expect(profileInUse("Executable doesn't exist at ...")).toBe(false);
  });
});
