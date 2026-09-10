import { promises as fs } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { candidateProfileSources, profileInUse, seedProfile, type ProfileSource, type SeedResult } from "./browser-profile.js";

/**
 * One browser, one profile, one page per conversation.
 *
 * The profile is Promptor's own directory, seeded once from the browser the
 * reader actually uses -- a fresh profile is what the bot checks in front of
 * some sign-in pages exist to stop, so borrowing the cookies is what makes
 * signing in work at all. Only the sign-in is copied: no history, no saved
 * passwords, no extensions.
 *
 * It is a copy rather than the directory itself because Chrome will not open a
 * user-data-dir another Chrome already holds; sharing one for real would mean
 * Promptor and the reader's browser could never run at the same time.
 * `shared: true` does exactly that for anyone who wants it, at that price.
 *
 * Promptor never types the credentials. It opens the window, and waits.
 */

export type BrowserLaunch = {
  /** Where the profile lives. Created on first launch and kept across restarts. */
  userDataDir: string;
  /** An installed browser, not a downloaded one: "chrome" or "msedge". */
  channel?: string;
  headless?: boolean;
  /** Use `userDataDir` as-is, without seeding: the reader's own directory. */
  shared?: boolean;
  /** Where to copy the sign-in from. Defaults to the installed Chrome, then Edge. */
  sources?: readonly ProfileSource[];
};

export class BrowserUnavailableError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

/** The subset of playwright this app uses, so tests can supply their own. */
export type BrowserDriver = {
  launchPersistentContext(userDataDir: string, options: Record<string, unknown>): Promise<BrowserContext>;
};

const CHANNELS = ["chrome", "msedge"] as const;

export class BrowserPool {
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private readonly pages = new Map<string, Page>();
  /** What the last launch borrowed, for the panel to report. */
  private lastSeed: SeedResult | null = null;

  constructor(
    private readonly launch: BrowserLaunch,
    private readonly driver: () => Promise<BrowserDriver> = defaultDriver,
  ) {}

  get running(): boolean { return this.context !== null; }
  get seed(): SeedResult | null { return this.lastSeed; }

  /**
   * Copy the sign-in across again, for when the borrowed one has expired.
   *
   * The browser has to come down for it: the files being replaced are the ones
   * it has open. Conversations reopen on their own afterwards.
   */
  async reseed(): Promise<SeedResult> {
    if (this.launch.shared) throw new BrowserUnavailableError("BROWSER_PROFILE_SHARED", "共用配置目录时没有可导入的东西，登录状态本来就是同一份。");
    await this.stopAll();
    this.lastSeed = await seedProfile(this.launch.userDataDir, this.launch.sources ?? candidateProfileSources(), { force: true });
    return this.lastSeed;
  }

  /**
   * The shared context, launched on demand.
   *
   * Tries the channels in order so a machine with only Edge still works --
   * every Windows install has one of them, which is why nothing is downloaded.
   */
  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const driver = await this.driver();
      await fs.mkdir(this.launch.userDataDir, { recursive: true });
      const sources = this.launch.sources ?? candidateProfileSources();
      if (!this.launch.shared) this.lastSeed = await seedProfile(this.launch.userDataDir, sources);
      // Prefer the browser the sign-in came from: cookies encrypted by Chrome
      // are not readable by Edge and the other way round.
      const preferred = this.lastSeed?.from
        ? sources.find((source) => source.userDataDir === this.lastSeed!.from)?.channel
        : undefined;
      const channels = this.launch.channel ? [this.launch.channel] : [...new Set([preferred, ...CHANNELS].filter(Boolean) as string[])];
      const failures: string[] = [];
      for (const channel of channels) {
        try {
          const context = await driver.launchPersistentContext(this.launch.userDataDir, {
            channel,
            headless: this.launch.headless ?? false,
            viewport: null,
            acceptDownloads: true,
            args: ["--no-first-run", "--no-default-browser-check"],
          });
          this.context = context;
          context.on("close", () => { this.context = null; this.pages.clear(); });
          return context;
        } catch (error) {
          failures.push(`${channel}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const joined = failures.join("；");
      if (profileInUse(joined)) {
        throw new BrowserUnavailableError("BROWSER_PROFILE_IN_USE", `这个浏览器配置目录正被另一个浏览器占用，请先完全退出它再试。${joined}`);
      }
      throw new BrowserUnavailableError("BROWSER_NOT_FOUND", `没有找到可用的 Chrome 或 Edge。${joined}`);
    })();
    try { return await this.launching; }
    finally { this.launching = null; }
  }

  /** This conversation's page, opened if it does not have one yet. */
  async page(tabId: string): Promise<Page> {
    const existing = this.pages.get(tabId);
    if (existing && !existing.isClosed()) return existing;
    const context = await this.ensureContext();
    const page = await context.newPage();
    page.on("close", () => { if (this.pages.get(tabId) === page) this.pages.delete(tabId); });
    this.pages.set(tabId, page);
    return page;
  }

  existing(tabId: string): Page | null {
    const page = this.pages.get(tabId);
    return page && !page.isClosed() ? page : null;
  }

  /** Close one conversation's page. The browser stays up for the others. */
  async close(tabId: string): Promise<void> {
    const page = this.pages.get(tabId);
    this.pages.delete(tabId);
    if (page && !page.isClosed()) await page.close().catch(() => undefined);
  }

  /** Raise this conversation's window. Loopback-only, from the page's own panel. */
  async bringToFront(tabId: string): Promise<boolean> {
    const page = this.existing(tabId);
    if (!page) return false;
    await page.bringToFront().catch(() => undefined);
    return true;
  }

  async stopAll(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.pages.clear();
    if (!context) return;
    await context.close().catch(() => undefined);
    await (context.browser() as Browser | null)?.close().catch(() => undefined);
  }
}

/** Resolved lazily so a machine that never opens a web conversation never loads it. */
async function defaultDriver(): Promise<BrowserDriver> {
  try {
    const { chromium } = await import("playwright-core");
    return chromium as unknown as BrowserDriver;
  } catch (error) {
    throw new BrowserUnavailableError("BROWSER_DRIVER_MISSING", `playwright-core 不可用：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function defaultProfileDir(dataDir: string): string {
  return path.join(dataDir, "private", "browser");
}

/**
 * How the reader configured this, if at all.
 *
 * `CODEX_PROMPTOR_BROWSER_PROFILE` points at a directory to use as-is -- the
 * reader's own, if they want one browser and not two. Only one of Promptor and
 * that browser may then be running.
 */
export function browserLaunchFromEnv(dataDir: string, env: NodeJS.ProcessEnv = process.env): BrowserLaunch {
  const shared = env.CODEX_PROMPTOR_BROWSER_PROFILE?.trim();
  return {
    userDataDir: shared || defaultProfileDir(dataDir),
    shared: Boolean(shared),
    channel: env.CODEX_PROMPTOR_BROWSER_CHANNEL?.trim() || undefined,
  };
}
