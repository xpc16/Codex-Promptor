import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Download, Page } from "playwright-core";
import type { QueueRpc } from "./queue.js";
import { sameSubmittedPrompt } from "./prompt-submit.js";
import {
  CHATGPT_ORIGIN,
  READ_MESSAGES,
  SELECTORS,
  conversationIdFrom,
  conversationUrl,
  historyTurn,
  turnSettled,
  turnsFromMessages,
  type PageMessage,
  type PageTurn,
  type TurnSample,
} from "./chatgpt-page.js";
import type { BrowserPool } from "./browser.js";

/**
 * The ChatGPT web app behind the same six methods every other provider is
 * behind. Nothing above `QueueRpc` learns that this one has no process.
 */

export type ChatGptSessionInfo = { conversationId: string | null; url: string };
export type ChatGptLaunch = { mode: "new" } | { mode: "resume"; conversationId: string };

const SUBMIT_CONFIRM_MS = 20_000;
const TURN_POLL_MS = 400;
const TURN_QUIET_MS = 1_600;
const TURN_TIMEOUT_MS = 30 * 60_000;
const LOGIN_WAIT_MS = 5 * 60_000;

export class ChatGptError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChatGptError";
  }
}

type ActiveTurn = {
  turnId: string;
  startedAt: string;
  settled: Promise<{ turn: unknown; items: unknown[] }>;
  interrupt: () => Promise<void>;
};

export class ChatGptManager extends EventEmitter {
  readonly rpc: QueueRpc;
  private attached: ChatGptSessionInfo | null = null;
  private turn: ActiveTurn | null = null;
  /** Files the page offered while the current turn ran. */
  private downloads: string[] = [];
  private downloadDir: string | null = null;

  constructor(readonly tabId: string, private readonly browser: BrowserPool, private readonly dataDir: string) {
    super();
    this.on("error", () => undefined);
    this.rpc = {
      activeTurnIds: () => (this.turn ? [this.turn.turnId] : []),
      waitForThreadIdle: (_threadId, timeoutMs) => this.waitForIdle(timeoutMs),
      startTurn: (threadId, text, clientId) => this.startTurn(threadId, text, clientId),
      steerTurn: async () => { throw new ChatGptError("CHATGPT_NO_STEER", "网页版没有把内容追加进正在进行的这一轮的办法。"); },
      interruptTurn: () => this.interruptTurn(),
      waitForTurn: () => this.waitForTurn(),
    };
  }

  get session(): ChatGptSessionInfo | null { return this.attached ? { ...this.attached } : null; }

  /** Files produced by the turn that just finished, as absolute paths. */
  takeDownloads(): string[] {
    const produced = this.downloads;
    this.downloads = [];
    return produced;
  }

  private async page(): Promise<Page> {
    const page = this.browser.existing(this.tabId);
    if (!page) throw new ChatGptError("CHATGPT_PAGE_CLOSED", "这个对话的浏览器页面已经关闭，请重新打开。");
    return page;
  }

  /**
   * Open the conversation and wait until it is usable.
   *
   * Being signed out is a state, not a failure: the window is already in front
   * of the reader, so this waits for them to sign in rather than erroring out
   * on something only they can do.
   */
  async open(launch: ChatGptLaunch): Promise<ChatGptSessionInfo> {
    const page = await this.browser.page(this.tabId);
    const url = launch.mode === "resume" ? conversationUrl(launch.conversationId) : `${CHATGPT_ORIGIN}/`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.waitForComposer(page);
    // A new conversation has no id until the first prompt creates one, exactly
    // like a Codex thread. Reporting that honestly beats inventing one.
    const conversationId = launch.mode === "resume"
      ? launch.conversationId
      : conversationIdFrom(page.url());
    this.attached = { conversationId, url: page.url() };
    return { ...this.attached };
  }

  private async waitForComposer(page: Page): Promise<void> {
    try {
      await page.waitForSelector(SELECTORS.composer, { timeout: LOGIN_WAIT_MS, state: "visible" });
    } catch {
      throw new ChatGptError("CHATGPT_NOT_SIGNED_IN", "还没有在这个窗口里登录 ChatGPT。请在弹出的浏览器窗口里登录后重新打开。");
    }
  }

  async signedIn(): Promise<boolean> {
    const page = this.browser.existing(this.tabId);
    if (!page) return false;
    return page.locator(SELECTORS.composer).first().isVisible().catch(() => false);
  }

  private async waitForIdle(timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.turn) {
      if (Date.now() > deadline) throw new Error("THREAD_IDLE_TIMEOUT");
      await delay(200);
    }
  }

  /**
   * Attach whatever this turn carries, put the text in the composer, send it,
   * and confirm from the page's own record that it landed.
   */
  async startTurn(threadId: string, text: string, _clientId: string, attachments: readonly string[] = []): Promise<{ turnId: string }> {
    if (this.turn) throw new ChatGptError("CHATGPT_BUSY", "这个对话还有一轮没有结束。");
    const page = await this.page();
    const before = await this.readMessages(page);
    for (const file of attachments) await this.attach(page, file);
    await page.fill(SELECTORS.composer, text);
    await page.click(SELECTORS.sendButton, { timeout: 15_000 }).catch(async () => {
      // Some builds submit on Enter and hide the button until the composer has
      // focus. Falling back keeps a UI tweak from stalling the queue.
      await page.press(SELECTORS.composer, "Enter");
    });
    const startedAt = new Date().toISOString();
    const accepted = await this.confirmSubmitted(page, text, before.length);
    if (!accepted) throw new ChatGptError("CHATGPT_SUBMIT_UNCONFIRMED", "页面里没有出现刚提交的这条消息，本轮未确认发出。");
    if (!this.attached?.conversationId) {
      const conversationId = conversationIdFrom(page.url());
      if (conversationId) this.attached = { conversationId, url: page.url() };
    }
    void threadId;
    this.beginDownloadCapture(page);
    const turnId = `pending-${startedAt}`;
    const settled = this.observeTurn(page, startedAt).catch((error) => {
      this.turn = null;
      throw error;
    });
    this.turn = { turnId, startedAt, settled, interrupt: () => this.clickStop(page) };
    return { turnId };
  }

  /** The page's own record of the submission, matched the way every adapter matches. */
  private async confirmSubmitted(page: Page, text: string, before: number): Promise<boolean> {
    const deadline = Date.now() + SUBMIT_CONFIRM_MS;
    while (Date.now() < deadline) {
      const messages = await this.readMessages(page);
      if (messages.length > before) {
        const user = [...messages].reverse().find((message) => message.role === "user");
        if (user && sameSubmittedPrompt(user.text, text)) return true;
      }
      await delay(250);
    }
    return false;
  }

  private async attach(page: Page, file: string): Promise<void> {
    try { await fs.access(file); }
    catch { throw new ChatGptError("ATTACH_FILE_NOT_FOUND", `找不到要上传的文件：${file}`); }
    const input = page.locator(SELECTORS.fileInput).first();
    await input.setInputFiles(file, { timeout: 30_000 });
    // The composer refuses to send while an upload is in flight; waiting for
    // the send button to come back is the page telling us it finished.
    await page.waitForSelector(SELECTORS.sendButton, { timeout: 120_000, state: "attached" }).catch(() => undefined);
  }

  private beginDownloadCapture(page: Page): void {
    this.downloads = [];
    const directory = this.downloadDir;
    if (!directory) return;
    const onDownload = (download: Download) => {
      void (async () => {
        const name = download.suggestedFilename() || `download-${Date.now()}`;
        const target = path.join(directory, name);
        await fs.mkdir(directory, { recursive: true }).catch(() => undefined);
        await download.saveAs(target).then(() => { this.downloads.push(target); }).catch(() => undefined);
      })();
    };
    page.on("download", onDownload);
    void this.turnFinished().finally(() => page.off("download", onDownload));
  }

  /** Where this turn's downloads go. Set by the caller, which knows the collaboration. */
  setDownloadDir(directory: string | null): void { this.downloadDir = directory; }

  private async turnFinished(): Promise<void> {
    while (this.turn) await delay(200);
  }

  private async observeTurn(page: Page, startedAt: string): Promise<{ turn: unknown; items: unknown[] }> {
    const samples: TurnSample[] = [];
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await delay(TURN_POLL_MS);
      const streaming = await page.locator(SELECTORS.stopButton).first().isVisible().catch(() => false);
      const messages = await this.readMessages(page);
      const assistant = [...messages].reverse().find((message) => message.role === "assistant") ?? null;
      samples.push({
        at: Date.now(),
        streaming,
        assistantId: assistant?.id ?? null,
        assistantText: assistant?.text ?? "",
      });
      if (samples.length > 64) samples.splice(0, samples.length - 64);
      if (!turnSettled(samples, TURN_QUIET_MS)) continue;
      const turns = turnsFromMessages(messages);
      const last = turns[turns.length - 1];
      if (!last) break;
      return historyTurn(last, startedAt, new Date().toISOString());
    }
    throw new ChatGptError("CHATGPT_TURN_UNCONFIRMED", "页面一直没有给出可识别的回答结束信号。");
  }

  async waitForTurn(): Promise<{ turn: any; items: any[] }> {
    const active = this.turn;
    if (!active) throw new ChatGptError("CHATGPT_TURN_NOT_ACTIVE", "没有正在进行的轮次。");
    try { return await active.settled as { turn: any; items: any[] }; }
    finally { if (this.turn === active) this.turn = null; }
  }

  private async interruptTurn(): Promise<void> {
    const page = this.browser.existing(this.tabId);
    if (page) await this.clickStop(page);
  }

  private async clickStop(page: Page): Promise<void> {
    await page.click(SELECTORS.stopButton, { timeout: 5_000 }).catch(() => undefined);
  }

  private async readMessages(page: Page): Promise<PageMessage[]> {
    return page.evaluate(READ_MESSAGES).catch(() => []) as Promise<PageMessage[]>;
  }

  /** Every turn the page currently shows, for history reconciliation. */
  async readHistory(): Promise<PageTurn[]> {
    const page = await this.page();
    return turnsFromMessages(await this.readMessages(page));
  }

  async stop(): Promise<void> {
    this.turn = null;
    this.attached = null;
    await this.browser.close(this.tabId);
  }
}

export class ChatGptPool {
  private readonly managers = new Map<string, ChatGptManager>();
  constructor(private readonly browser: BrowserPool, private readonly dataDir: string) {}

  get(tabId: string): ChatGptManager {
    let manager = this.managers.get(tabId);
    if (!manager) {
      manager = new ChatGptManager(tabId, this.browser, this.dataDir);
      this.managers.set(tabId, manager);
    }
    return manager;
  }

  existing(tabId: string): ChatGptManager | null { return this.managers.get(tabId) ?? null; }

  async stop(tabId: string): Promise<void> {
    const manager = this.managers.get(tabId);
    this.managers.delete(tabId);
    await manager?.stop().catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.managers.keys()].map((tabId) => this.stop(tabId)));
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
