import { promises as fs } from "node:fs";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";

/**
 * One browser, one profile, one page per conversation.
 *
 * The profile is Promptor's own, under `data/private/browser`, and never the
 * one the reader browses with. Driving that one would hand every cookie it
 * holds -- mail, bank, anything -- to a process that runs whatever a prompt
 * tells it to. A separate profile is the only isolation available here, and
 * its cost is signing in once inside the window it opens.
 *
 * Promptor never types the credentials. It opens the window, and waits.
 */

export type BrowserLaunch = {
  /** Where the profile lives. Created on first launch and kept across restarts. */
  userDataDir: string;
  /** An installed browser, not a downloaded one: "chrome" or "msedge". */
  channel?: string;
  headless?: boolean;
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

  constructor(
    private readonly launch: BrowserLaunch,
    private readonly driver: () => Promise<BrowserDriver> = defaultDriver,
  ) {}

  get running(): boolean { return this.context !== null; }

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
      const channels = this.launch.channel ? [this.launch.channel] : [...CHANNELS];
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
      throw new BrowserUnavailableError("BROWSER_NOT_FOUND", `没有找到可用的 Chrome 或 Edge。${failures.join("；")}`);
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
