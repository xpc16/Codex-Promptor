import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import writeFileAtomic from "write-file-atomic";
import {
  AnswerFileSchema,
  type AnswerFile,
  defaultAnswerFile,
  defaultPromptFile,
  defaultRuntime,
  IndexFileSchema,
  isoNow,
  type IndexFile,
  type Group,
  type PromptFile,
  PromptFileSchema,
  type RuntimeFile,
  RuntimeFileSchema,
  type TabBundle,
  type TabMeta,
  TabMetaSchema,
  defaultSession,
} from "../shared/schemas.js";
import { latestQueueCompletion, type TabActivitySummary } from "../shared/tab-activity.js";

export class KeyedMutex {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(key, current);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

type AtomicWriter = (
  filePath: string,
  data: string,
  options: { encoding: "utf8" },
) => Promise<void>;

const retryDelay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export async function writeFileAtomicWithRetry(
  filePath: string,
  data: string,
  writer: AtomicWriter = writeFileAtomic as AtomicWriter,
  delay: (milliseconds: number) => Promise<void> = retryDelay,
): Promise<void> {
  const attempts = 8;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await writer(filePath, data, { encoding: "utf8" });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      const retryable = code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!retryable || attempt === attempts - 1) throw error;
      await delay(Math.min(500, 40 * (2 ** attempt)));
    }
  }
}

export class StorageService {
  readonly rootDir: string;
  readonly dataDir: string;
  readonly tabsDir: string;
  readonly backupsDir: string;
  readonly trashDir: string;
  readonly mutex = new KeyedMutex();

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.dataDir = path.join(this.rootDir, "data");
    this.tabsDir = path.join(this.dataDir, "tabs");
    this.backupsDir = path.join(this.dataDir, "backups");
    this.trashDir = path.join(this.dataDir, "trash");
  }

  async ensure(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.tabsDir, { recursive: true }),
      fs.mkdir(this.backupsDir, { recursive: true }),
      fs.mkdir(this.trashDir, { recursive: true }),
    ]);
    try {
      await fs.access(this.indexPath());
    } catch {
      await this.writeIndex({
        schemaVersion: 1,
        revision: 0,
        updatedAt: isoNow(),
        groups: [],
        tabs: [],
        ui: { consoleWidth: 300, theme: "light", locale: "zh-CN", ungroupedCollapsed: false },
      });
    }
  }

  indexPath(): string { return path.join(this.dataDir, "index.json"); }
  tabDir(tabId: string): string { return path.join(this.tabsDir, tabId); }
  tabPath(tabId: string): string { return path.join(this.tabDir(tabId), "tab.json"); }
  promptPath(tabId: string): string { return path.join(this.tabDir(tabId), "prompt-list.json"); }
  answerPath(tabId: string): string { return path.join(this.tabDir(tabId), "final-answers.json"); }
  runtimePath(tabId: string): string { return path.join(this.tabDir(tabId), "runtime.json"); }

  private async readFile<T>(filePath: string, parse: (value: unknown) => T): Promise<T> {
    const contents = await fs.readFile(filePath, "utf8");
    return parse(JSON.parse(contents));
  }

  private async writeFile(filePath: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeFileAtomicWithRetry(filePath, json(value));
  }

  async readIndex(): Promise<IndexFile> {
    await this.ensure();
    return this.readFile(this.indexPath(), (value) => IndexFileSchema.parse(value));
  }

  async writeIndex(index: IndexFile): Promise<void> {
    await this.writeFile(this.indexPath(), IndexFileSchema.parse(index));
  }

  async updateIndex(mutator: (index: IndexFile) => IndexFile | Promise<IndexFile>): Promise<IndexFile> {
    return this.mutex.run("index", async () => {
      const current = await this.readIndex();
      const next = await mutator(current);
      const value = IndexFileSchema.parse({ ...next, revision: current.revision + 1, updatedAt: isoNow() });
      await this.writeIndex(value);
      return value;
    });
  }

  async createTab(name = "未命名对话"): Promise<TabMeta> {
    const now = isoNow();
    const id = randomUUID();
    const tab: TabMeta = {
      id,
      name,
      groupId: null,
      order: 0,
      createdAt: now,
      updatedAt: now,
      session: defaultSession(),
      layout: { leftWidthPercent: 42 },
    };
    await this.mutex.run("index", async () => {
      const index = await this.readIndex();
      tab.order = index.tabs.length;
      await fs.mkdir(this.tabDir(id), { recursive: true });
      await Promise.all([
        this.writeFile(this.tabPath(id), tab),
        this.writeFile(this.promptPath(id), defaultPromptFile()),
        this.writeFile(this.answerPath(id), defaultAnswerFile()),
        this.writeFile(this.runtimePath(id), defaultRuntime()),
      ]);
      const next = IndexFileSchema.parse({
        ...index,
        revision: index.revision + 1,
        updatedAt: now,
        tabs: [...index.tabs, tab],
      });
      await this.writeIndex(next);
    });
    return tab;
  }

  async readTab(tabId: string): Promise<TabBundle> {
    const [tab, prompts, answers, runtime] = await Promise.all([
      this.readFile(this.tabPath(tabId), (value) => TabMetaSchema.parse(value)),
      this.readFile(this.promptPath(tabId), (value) => PromptFileSchema.parse(value)),
      this.readFile(this.answerPath(tabId), (value) => AnswerFileSchema.parse(value)),
      this.readFile(this.runtimePath(tabId), (value) => RuntimeFileSchema.parse(value)),
    ]);
    return { tab, prompts, answers, runtime };
  }

  async readTabActivity(tabId: string): Promise<TabActivitySummary> {
    const [prompts, runtime] = await Promise.all([
      this.readFile(this.promptPath(tabId), (value) => PromptFileSchema.parse(value)),
      this.readFile(this.runtimePath(tabId), (value) => RuntimeFileSchema.parse(value)),
    ]);
    return {
      runnerState: runtime.runner.state,
      desiredState: runtime.runner.desiredState,
      activePromptId: runtime.runner.activePromptId,
      lastQueueCompletedAt: latestQueueCompletion(prompts.prompts),
    };
  }

  async tabExists(tabId: string): Promise<boolean> {
    try { await fs.access(this.tabDir(tabId)); return true; } catch { return false; }
  }

  async withTabLock<T>(tabId: string, task: () => Promise<T>): Promise<T> {
    return this.mutex.run(`tab:${tabId}`, task);
  }

  async writeTab(tab: TabMeta): Promise<void> {
    await this.writeFile(this.tabPath(tab.id), TabMetaSchema.parse(tab));
  }

  async writePrompts(tabId: string, prompts: PromptFile): Promise<void> {
    await this.writeFile(this.promptPath(tabId), PromptFileSchema.parse(prompts));
  }

  async writeAnswers(tabId: string, answers: AnswerFile): Promise<void> {
    await this.writeFile(this.answerPath(tabId), AnswerFileSchema.parse(answers));
  }

  async writeRuntime(tabId: string, runtime: RuntimeFile): Promise<void> {
    await this.writeFile(this.runtimePath(tabId), RuntimeFileSchema.parse(runtime));
  }

  async updateTab(tabId: string, mutator: (tab: TabMeta) => TabMeta | Promise<TabMeta>): Promise<TabMeta> {
    return this.withTabLock(tabId, async () => {
      const current = (await this.readTab(tabId)).tab;
      const next = TabMetaSchema.parse(await mutator(current));
      await this.writeTab(next);
      await this.updateIndex((index) => ({
        ...index,
        tabs: index.tabs.map((item) => item.id === tabId ? next : item),
      }));
      return next;
    });
  }

  async getTabMeta(tabId: string): Promise<TabMeta> {
    const index = await this.readIndex();
    const tab = index.tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error(`TAB_NOT_FOUND:${tabId}`);
    return tab;
  }

  async deleteTab(tabId: string): Promise<void> {
    await this.mutex.run("index", async () => {
      const index = await this.readIndex();
      if (!index.tabs.some((tab) => tab.id === tabId)) throw new Error(`TAB_NOT_FOUND:${tabId}`);
      const target = path.resolve(this.tabDir(tabId));
      const tabsRoot = path.resolve(this.tabsDir) + path.sep;
      if (!target.startsWith(tabsRoot)) throw new Error("INVALID_TAB_PATH");
      await fs.mkdir(this.trashDir, { recursive: true });
      const trashTarget = path.join(this.trashDir, `${tabId}-${Date.now()}`);
      await renameDirectoryWithRetry(target, trashTarget);
      await this.writeIndex(IndexFileSchema.parse({
        ...index,
        revision: index.revision + 1,
        updatedAt: isoNow(),
        tabs: index.tabs.filter((tab) => tab.id !== tabId),
      }));
    });
  }

  async setGroups(groups: Group[]): Promise<IndexFile> {
    return this.updateIndex((index) => ({ ...index, groups }));
  }

  async listTabMeta(): Promise<TabMeta[]> {
    const index = await this.readIndex();
    return [...index.tabs].sort((a, b) => a.order - b.order);
  }
}

async function renameDirectoryWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      if ((error?.code !== "EPERM" && error?.code !== "EBUSY") || attempt === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 80 * (attempt + 1)));
    }
  }
}
