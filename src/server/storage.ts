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
  type AnswerRecord,
  type PromptRecord,
  type TabBundle,
  type TabRecordPage,
  type TabMeta,
  TabMetaSchema,
  defaultSession,
} from "../shared/schemas.js";
import { latestQueueCompletion, type TabActivitySummary } from "../shared/tab-activity.js";
import { buildRecordDelta, type AnswerDelta, type PromptDelta } from "../shared/tab-delta.js";
import {
  EARLIER_ANSWER_PAGE,
  EARLIER_PROMPT_PAGE,
  INITIAL_ANSWER_WINDOW,
  INITIAL_PROMPT_WINDOW,
  MAX_WINDOW_RECORDS,
  tailWindowStart,
} from "../shared/tab-window.js";

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
  private readonly indexListeners = new Set<(index: IndexFile) => void>();
  private readonly tabListeners = new Set<(tabId: string, tab: TabMeta) => void>();
  private readonly promptListeners = new Set<(tabId: string, delta: PromptDelta) => void>();
  private readonly answerListeners = new Set<(tabId: string, delta: AnswerDelta) => void>();
  private readonly runtimeListeners = new Set<(tabId: string, runtime: RuntimeFile) => void>();

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

  /**
   * Every index write funnels through writeIndex, so a listener here sees all
   * navigation changes — renames, deletions, group moves, reordering, session
   * state — no matter which route made them. Registering per-route would go
   * stale the moment someone adds another one.
   */
  onIndexChanged(listener: (index: IndexFile) => void): () => void {
    this.indexListeners.add(listener);
    return () => { this.indexListeners.delete(listener); };
  }

  onTabChanged(listener: (tabId: string, tab: TabMeta) => void): () => void { this.tabListeners.add(listener); return () => { this.tabListeners.delete(listener); }; }
  onPromptsChanged(listener: (tabId: string, delta: PromptDelta) => void): () => void { this.promptListeners.add(listener); return () => { this.promptListeners.delete(listener); }; }
  onAnswersChanged(listener: (tabId: string, delta: AnswerDelta) => void): () => void { this.answerListeners.add(listener); return () => { this.answerListeners.delete(listener); }; }
  onRuntimeChanged(listener: (tabId: string, runtime: RuntimeFile) => void): () => void { this.runtimeListeners.add(listener); return () => { this.runtimeListeners.delete(listener); }; }

  async writeIndex(index: IndexFile): Promise<void> {
    const value = IndexFileSchema.parse(index);
    await this.writeFile(this.indexPath(), value);
    for (const listener of this.indexListeners) {
      // The write already landed; a listener that throws must not turn a
      // successful save into a failed request.
      try { listener(value); } catch { /* notification is best-effort */ }
    }
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

  async readTabWindow(tabId: string, promptLimit = INITIAL_PROMPT_WINDOW, answerLimit = INITIAL_ANSWER_WINDOW): Promise<TabBundle> {
    const bundle = await this.readTab(tabId);
    const { prompts, answers } = recordsForCurrentThread(bundle);
    // The queue's actionable rows -- the turn running now and everything still
    // waiting to run -- always ship whole. Reordering the queue sends the full
    // pending list back, so a window that clipped it would make drag-and-drop
    // fail. Only settled history is paged.
    const promptStart = tailWindowStart(
      prompts.length,
      boundedPageLimit(promptLimit, INITIAL_PROMPT_WINDOW),
      [prompts.findIndex((prompt) => prompt.status === "running"), prompts.findIndex((prompt) => prompt.status === "pending")],
    );
    const answerStart = tailWindowStart(
      answers.length,
      boundedPageLimit(answerLimit, INITIAL_ANSWER_WINDOW),
      [answers.findIndex((answer) => answer.status === "running")],
    );
    return {
      ...bundle,
      prompts: { ...bundle.prompts, prompts: prompts.slice(promptStart) },
      answers: { ...bundle.answers, answers: answers.slice(answerStart) },
      window: {
        prompts: { start: promptStart, total: prompts.length, completed: prompts.filter((prompt) => prompt.status === "completed").length },
        answers: { start: answerStart, total: answers.length },
      },
    };
  }

  async readPromptPage(tabId: string, before: number, limit = EARLIER_PROMPT_PAGE): Promise<TabRecordPage<PromptRecord>> {
    const bundle = await this.readTab(tabId);
    const records = recordsForCurrentThread(bundle).prompts;
    return recordPage(records, before, limit, EARLIER_PROMPT_PAGE, bundle.prompts.revision, bundle.prompts.updatedAt);
  }

  async readAnswerPage(tabId: string, before: number, limit = EARLIER_ANSWER_PAGE): Promise<TabRecordPage<AnswerRecord>> {
    const bundle = await this.readTab(tabId);
    const records = recordsForCurrentThread(bundle).answers;
    return recordPage(records, before, limit, EARLIER_ANSWER_PAGE, bundle.answers.revision, bundle.answers.updatedAt);
  }

  /** The runtime file on its own -- what a queue control changes, and all it needs to report. */
  async readRuntime(tabId: string): Promise<RuntimeFile> {
    return this.readFile(this.runtimePath(tabId), (value) => RuntimeFileSchema.parse(value));
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
    const value = TabMetaSchema.parse(tab);
    await this.writeFile(this.tabPath(tab.id), value);
    notify(this.tabListeners, (listener) => listener(value.id, value));
  }

  async writePrompts(tabId: string, prompts: PromptFile): Promise<PromptDelta> {
    const value = PromptFileSchema.parse(prompts);
    const [previous, tab, answers] = await Promise.all([
      this.readFile(this.promptPath(tabId), (raw) => PromptFileSchema.parse(raw)).catch(() => null),
      this.readFile(this.tabPath(tabId), (raw) => TabMetaSchema.parse(raw)).catch(() => null),
      this.readFile(this.answerPath(tabId), (raw) => AnswerFileSchema.parse(raw)).catch(() => null),
    ]);
    await this.writeFile(this.promptPath(tabId), value);
    const currentAnswers = answers?.answers ?? [];
    const previousRecords = tab && previous
      ? currentPromptRecords(tab, previous.prompts, currentAnswers)
      : previous?.prompts ?? null;
    const nextRecords = tab
      ? currentPromptRecords(tab, value.prompts, currentAnswers)
      : value.prompts;
    const delta: PromptDelta = {
      ...buildRecordDelta(previousRecords, nextRecords, value.revision, value.updatedAt),
      completed: nextRecords.filter((prompt) => prompt.status === "completed").length,
    };
    notify(this.promptListeners, (listener) => listener(tabId, delta));
    // Returned so a route can echo the same delta it just broadcast: the
    // caller then needs nothing back but the handful of records that changed.
    return delta;
  }

  async writeAnswers(tabId: string, answers: AnswerFile): Promise<AnswerDelta> {
    const value = AnswerFileSchema.parse(answers);
    const [previous, tab] = await Promise.all([
      this.readFile(this.answerPath(tabId), (raw) => AnswerFileSchema.parse(raw)).catch(() => null),
      this.readFile(this.tabPath(tabId), (raw) => TabMetaSchema.parse(raw)).catch(() => null),
    ]);
    await this.writeFile(this.answerPath(tabId), value);
    const previousRecords = tab && previous
      ? currentAnswerRecords(tab, previous.answers)
      : previous?.answers ?? null;
    const nextRecords = tab
      ? currentAnswerRecords(tab, value.answers)
      : value.answers;
    const delta = buildRecordDelta(previousRecords, nextRecords, value.revision, value.updatedAt) as AnswerDelta;
    notify(this.answerListeners, (listener) => listener(tabId, delta));
    return delta;
  }

  async writeRuntime(tabId: string, runtime: RuntimeFile): Promise<void> {
    const value = RuntimeFileSchema.parse(runtime);
    await this.writeFile(this.runtimePath(tabId), value);
    notify(this.runtimeListeners, (listener) => listener(tabId, value));
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

function recordsForCurrentThread(bundle: TabBundle): { prompts: PromptRecord[]; answers: AnswerRecord[] } {
  const answers = currentAnswerRecords(bundle.tab, bundle.answers.answers);
  const prompts = currentPromptRecords(bundle.tab, bundle.prompts.prompts, answers);
  return { prompts, answers };
}

function currentAnswerRecords(tab: TabMeta, records: readonly AnswerRecord[]): AnswerRecord[] {
  if (tab.session.provider === "shell" || !tab.session.threadId) return [];
  return records.filter((answer) => answer.threadId === tab.session.threadId);
}

function currentPromptRecords(tab: TabMeta, records: readonly PromptRecord[], answers: readonly AnswerRecord[]): PromptRecord[] {
  if (tab.session.provider === "shell") return [];
  const threadId = tab.session.threadId;
  const answerPromptIds = new Set(answers.map((answer) => answer.promptId));
  return records
    .filter((prompt) => Boolean(threadId) && prompt.threadId === threadId
      || (!prompt.threadId && answerPromptIds.has(prompt.id))
      || (prompt.status === "pending" && !prompt.threadId))
    .map(withoutTransportBallast);
}

/**
 * `inputSnapshot` is reconciliation provenance -- the raw turn input the agent
 * reported -- and it is the largest field on a prompt record, averaging twice
 * the prompt text itself. No screen renders it, so it stays on disk and out of
 * every read and broadcast. Both sides of a delta comparison come through
 * here, so dropping it cannot manufacture a spurious change.
 */
function withoutTransportBallast(prompt: PromptRecord): PromptRecord {
  if (prompt.inputSnapshot === undefined) return prompt;
  const { inputSnapshot: _dropped, ...rest } = prompt;
  return rest as PromptRecord;
}

function recordPage<T>(records: T[], before: number, limit: number, fallbackLimit: number, revision: number, updatedAt: string): TabRecordPage<T> {
  const end = Math.max(0, Math.min(records.length, Number.isFinite(before) ? Math.trunc(before) : records.length));
  const start = Math.max(0, end - boundedPageLimit(limit, fallbackLimit));
  return { records: records.slice(start, end), start, total: records.length, revision, updatedAt };
}

function boundedPageLimit(value: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_WINDOW_RECORDS, Math.trunc(number))) : fallback;
}

function notify<T>(listeners: ReadonlySet<T>, call: (listener: T) => void): void {
  for (const listener of listeners) {
    try { call(listener); } catch { /* persistence succeeded; notifications are best-effort */ }
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
