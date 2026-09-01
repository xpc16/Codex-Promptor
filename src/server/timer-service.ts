import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  isoNow,
  MAX_TIMER_PROMPTS,
  MAX_TIMERS_PER_TAB,
  newPrompt,
  TimerScheduleSchema,
  type PromptFile,
  type PromptRecord,
  type TabMeta,
  type Timer,
  type TimerFile,
} from "../shared/schemas.js";
import type { PromptDelta } from "../shared/tab-delta.js";
import { entityTag, ifMatchSatisfied } from "./http-cache.js";
import type { QueueRunner } from "./queue.js";
import { StorageService } from "./storage.js";
import { hostTimeZone, nextTimerRunAt, normalizeTimerRule } from "./timer-rules.js";

const MAX_WAKE_DELAY_MS = 30_000;
const ACTIVE_STATUSES = new Set(["pending", "dispatching", "running"]);

const TimerDraftSchema = z.object({
  title: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  externalQueuePolicy: z.enum(["priority", "after_running_queue"]),
  schedule: TimerScheduleSchema,
  prompts: z.array(z.object({ id: z.string().min(1).optional(), text: z.string().trim().min(1) })).min(1).max(MAX_TIMER_PROMPTS),
  bindToCurrentThread: z.boolean().optional(),
});
export type TimerDraft = z.input<typeof TimerDraftSchema>;

export class TimerServiceError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = "TimerServiceError";
  }
}

export type TimerMutationResult = { file: TimerFile; timer: Timer; etag: string };
export type TimerDeleteResult = { file: TimerFile; etag: string };
export type TimerRunNowResult = TimerMutationResult & { promptIds: string[] };

type TimerRunner = Pick<QueueRunner, "runOneShotBatch">;

export class TimerService {
  private readonly files = new Map<string, TimerFile>();
  private readonly loadedTabs = new Set<string>();
  private readonly activeTimerPromptIds = new Map<string, Set<string>>();
  private readonly detaching = new Set<string>();
  private wakeTimer: NodeJS.Timeout | null = null;
  private checking = false;
  private wakeRequested = false;
  private started = false;
  private stopping = false;
  private tickPromise: Promise<void> | null = null;
  private readonly unsubscribePrompts: () => void;
  private readonly unsubscribeTabs: () => void;

  constructor(
    private readonly storage: StorageService,
    private readonly runnerForTab: (tabId: string) => TimerRunner,
    private readonly setBackgroundHold: (key: string, active: boolean) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.unsubscribePrompts = storage.onPromptsChanged((tabId, delta) => this.onPromptDelta(tabId, delta));
    this.unsubscribeTabs = storage.onTabChanged((tabId, tab) => {
      if (tab.session.state === "ready" && this.loadedTabs.has(tabId)) void this.recoverAutoRuns(tabId);
    });
  }

  async start(): Promise<void> {
    if (this.started || this.stopping) return;
    this.started = true;
    for (const tab of await this.storage.listTabMeta()) {
      if (!await this.storage.hasTimerFile(tab.id)) continue;
      try {
        await this.loadTab(tab.id, true);
        await this.recoverAutoRuns(tab.id);
      } catch {
        // One malformed optional file must not disable ordinary conversations.
      }
    }
    this.updateBackgroundHold();
    this.wake();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.tickPromise) await Promise.allSettled([this.tickPromise]);
    this.unsubscribePrompts();
    this.unsubscribeTabs();
    this.setBackgroundHold("timers", false);
  }

  async getTimers(tabId: string): Promise<{ file: TimerFile; etag: string }> {
    this.assertAttached(tabId);
    await this.ensureTab(tabId);
    const file = await this.loadTab(tabId, false);
    return { file, etag: timerFileEtag(file) };
  }

  async createTimer(tabId: string, input: unknown, expectedEtag: string | string[] | undefined): Promise<TimerMutationResult> {
    this.assertAttached(tabId);
    return this.storage.withTabLock(tabId, async () => {
      this.assertAttached(tabId);
      const [file, tab] = await Promise.all([this.storage.readTimers(tabId), this.storage.getTabMeta(tabId)]);
      assertPrecondition(expectedEtag, timerFileEtag(file));
      if (file.timers.length >= MAX_TIMERS_PER_TAB) throw new TimerServiceError(422, "TIMER_LIMIT_REACHED", "This conversation already has the maximum number of timers.");
      const draft = parseDraft(input);
      const threadId = executableThread(tab);
      const timestamp = this.now().toISOString();
      const normalized = normalizeDraftRule(draft.schedule, this.now());
      const enabled = draft.enabled && normalized.nextRunAt !== null;
      const timer: Timer = {
        id: randomUUID(),
        title: draft.title,
        threadId,
        enabled,
        timeZone: hostTimeZone(),
        externalQueuePolicy: draft.externalQueuePolicy,
        schedule: normalized.schedule,
        prompts: normalizeTemplates(draft.prompts),
        nextRunAt: enabled ? normalized.nextRunAt : null,
        lastTrigger: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const next: TimerFile = { schemaVersion: 1, updatedAt: timestamp, timers: [...file.timers, timer] };
      await this.storage.writeTimers(tabId, next);
      this.remember(tabId, next);
      return { file: next, timer, etag: timerFileEtag(next) };
    });
  }

  async updateTimer(tabId: string, timerId: string, input: unknown, expectedEtag: string | string[] | undefined): Promise<TimerMutationResult> {
    this.assertAttached(tabId);
    return this.storage.withTabLock(tabId, async () => {
      this.assertAttached(tabId);
      const [file, tab] = await Promise.all([this.storage.readTimers(tabId), this.storage.getTabMeta(tabId)]);
      assertPrecondition(expectedEtag, timerFileEtag(file));
      const index = file.timers.findIndex((timer) => timer.id === timerId);
      if (index < 0) throw new TimerServiceError(404, "TIMER_NOT_FOUND", "Timer not found.");
      const current = file.timers[index];
      const draft = parseDraft(input);
      const timestamp = this.now().toISOString();
      const normalized = normalizeDraftRule(draft.schedule, this.now());
      const enabled = draft.enabled && normalized.nextRunAt !== null;
      const timer: Timer = {
        ...current,
        title: draft.title,
        threadId: draft.bindToCurrentThread ? executableThread(tab) : current.threadId,
        enabled,
        timeZone: hostTimeZone(),
        externalQueuePolicy: draft.externalQueuePolicy,
        schedule: normalized.schedule,
        prompts: normalizeTemplates(draft.prompts),
        nextRunAt: enabled ? normalized.nextRunAt : null,
        updatedAt: timestamp,
      };
      const timers = [...file.timers];
      timers[index] = timer;
      const next: TimerFile = { schemaVersion: 1, updatedAt: timestamp, timers };
      await this.storage.writeTimers(tabId, next);
      this.remember(tabId, next);
      return { file: next, timer, etag: timerFileEtag(next) };
    });
  }

  async deleteTimer(tabId: string, timerId: string, expectedEtag: string | string[] | undefined): Promise<TimerDeleteResult> {
    this.assertAttached(tabId);
    return this.storage.withTabLock(tabId, async () => {
      this.assertAttached(tabId);
      const file = await this.storage.readTimers(tabId);
      assertPrecondition(expectedEtag, timerFileEtag(file));
      if (!file.timers.some((timer) => timer.id === timerId)) throw new TimerServiceError(404, "TIMER_NOT_FOUND", "Timer not found.");
      const next: TimerFile = {
        schemaVersion: 1,
        updatedAt: this.now().toISOString(),
        timers: file.timers.filter((timer) => timer.id !== timerId),
      };
      await this.storage.writeTimers(tabId, next);
      this.remember(tabId, next);
      return { file: next, etag: timerFileEtag(next) };
    });
  }

  async runNow(tabId: string, timerId: string, idempotencyKey: string): Promise<TimerRunNowResult> {
    this.assertAttached(tabId);
    let promptIds: string[] = [];
    const result = await this.storage.withTabLock(tabId, async () => {
      this.assertAttached(tabId);
      const [file, bundle] = await Promise.all([this.storage.readTimers(tabId), this.storage.readTab(tabId)]);
      const index = file.timers.findIndex((timer) => timer.id === timerId);
      if (index < 0) throw new TimerServiceError(404, "TIMER_NOT_FOUND", "Timer not found.");
      const timer = file.timers[index];
      assertRunnableSession(bundle.tab, timer);
      const scheduledFor = `manual:${idempotencyKey}`;
      const occurrenceId = timerOccurrenceId(timer.id, scheduledFor);
      promptIds = timer.prompts.map((template) => timerPromptId(occurrenceId, template.id));
      if (promptIds.every((id) => bundle.prompts.prompts.some((prompt) => prompt.id === id))) {
        return { file, timer, etag: timerFileEtag(file) };
      }
      if (hasActiveTimerBatch(bundle.prompts, timer)) {
        throw new TimerServiceError(409, "TIMER_ALREADY_ACTIVE", "This timer already has an unfinished batch.");
      }
      const triggeredAt = this.now().toISOString();
      await this.materializePrompts(tabId, bundle.prompts, timer, occurrenceId, triggeredAt, true);
      const updated: Timer = {
        ...timer,
        lastTrigger: { occurrenceId, source: "manual", scheduledFor, triggeredAt, status: "queued", code: null },
        updatedAt: triggeredAt,
      };
      const timers = [...file.timers];
      timers[index] = updated;
      const next: TimerFile = { schemaVersion: 1, updatedAt: triggeredAt, timers };
      await this.storage.writeTimers(tabId, next);
      this.remember(tabId, next);
      return { file: next, timer: updated, etag: timerFileEtag(next) };
    });
    await this.runnerForTab(tabId).runOneShotBatch(promptIds);
    return { ...result, promptIds };
  }

  /** Deletion barrier: no scheduler/API write can recreate a moved tab. */
  async detachTab(tabId: string): Promise<void> {
    this.detaching.add(tabId);
    await this.storage.withTabLock(tabId, async () => undefined);
    this.files.delete(tabId);
    this.loadedTabs.delete(tabId);
    this.activeTimerPromptIds.delete(tabId);
    this.updateBackgroundHold();
    this.wake();
  }

  async reattachTab(tabId: string): Promise<void> {
    if (!this.detaching.delete(tabId) || !await this.storage.tabExists(tabId)) return;
    if (await this.storage.hasTimerFile(tabId)) {
      await this.loadTab(tabId, false);
      await this.recoverAutoRuns(tabId);
    }
    this.wake();
  }

  private async loadTab(tabId: string, normalizeForStartup: boolean): Promise<TimerFile> {
    if (!normalizeForStartup && this.loadedTabs.has(tabId)) return this.files.get(tabId)!;
    let file = await this.storage.readTimers(tabId);
    if (normalizeForStartup && file.timers.length) {
      const zone = hostTimeZone();
      const now = this.now();
      let changed = false;
      const timers = file.timers.map((timer) => {
        const legacyUtcInterval = timer.schedule.kind === "interval"
          && (/Z$/i.test(timer.schedule.anchorAt) || (timer.schedule.endAt !== null && /Z$/i.test(timer.schedule.endAt)));
        if (!legacyUtcInterval && timer.timeZone === zone && (!timer.enabled || timer.nextRunAt !== null)) return timer;
        const normalized = normalizeTimerRule(timer.schedule, now);
        const enabled = timer.enabled && normalized.nextRunAt !== null;
        changed = true;
        return { ...timer, timeZone: zone, schedule: normalized.schedule, enabled, nextRunAt: enabled ? normalized.nextRunAt : null, updatedAt: now.toISOString() };
      });
      if (changed) {
        file = { schemaVersion: 1, updatedAt: now.toISOString(), timers };
        await this.storage.withTabLock(tabId, () => this.storage.writeTimers(tabId, file));
      }
    }
    this.remember(tabId, file);
    if (normalizeForStartup) this.refreshPromptActivity(tabId, await this.storage.readPromptsOnly(tabId));
    return file;
  }

  private remember(tabId: string, file: TimerFile): void {
    this.loadedTabs.add(tabId);
    this.files.set(tabId, file);
    this.updateBackgroundHold();
    this.wake();
  }

  private wake(): void {
    if (!this.started || this.stopping) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    if (this.checking) { this.wakeRequested = true; return; }
    const nearest = [...this.files.values()]
      .flatMap((file) => file.timers)
      .filter((timer) => timer.enabled && timer.nextRunAt)
      .reduce<number | null>((best, timer) => {
        const value = Date.parse(timer.nextRunAt!);
        return Number.isFinite(value) && (best === null || value < best) ? value : best;
      }, null);
    if (nearest === null) return;
    const delay = Math.max(0, Math.min(MAX_WAKE_DELAY_MS, nearest - this.now().getTime()));
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      this.tickPromise = this.checkDueTimers().finally(() => { this.tickPromise = null; });
    }, delay);
    this.wakeTimer.unref?.();
  }

  private async checkDueTimers(): Promise<void> {
    if (this.checking || this.stopping) return;
    this.checking = true;
    try {
      const now = this.now();
      const due = [...this.files.entries()].flatMap(([tabId, file]) => file.timers
        .filter((timer) => timer.enabled && timer.nextRunAt && Date.parse(timer.nextRunAt) <= now.getTime())
        .map((timer) => ({ tabId, timerId: timer.id, scheduledFor: timer.nextRunAt! })));
      for (const item of due) await this.triggerScheduled(item.tabId, item.timerId, item.scheduledFor);
    } finally {
      this.checking = false;
      const requested = this.wakeRequested;
      this.wakeRequested = false;
      if (!this.stopping) {
        if (requested) queueMicrotask(() => this.wake());
        else this.wake();
      }
    }
  }

  private async triggerScheduled(tabId: string, timerId: string, scheduledFor: string): Promise<void> {
    if (this.detaching.has(tabId)) return;
    let batchIds: string[] = [];
    await this.storage.withTabLock(tabId, async () => {
      if (this.detaching.has(tabId)) return;
      const [file, bundle] = await Promise.all([this.storage.readTimers(tabId), this.storage.readTab(tabId)]);
      const index = file.timers.findIndex((timer) => timer.id === timerId);
      const timer = file.timers[index];
      if (!timer || !timer.enabled || timer.nextRunAt !== scheduledFor) return;
      const now = this.now();
      const triggeredAt = now.toISOString();
      const occurrenceId = timerOccurrenceId(timer.id, scheduledFor);
      const deterministicIds = timer.prompts.map((template) => timerPromptId(occurrenceId, template.id));
      const existingOccurrence = deterministicIds.some((id) => bundle.prompts.prompts.some((prompt) => prompt.id === id));
      let status: "queued" | "coalesced" | "blocked" = "queued";
      let code: string | null = null;

      if (!existingOccurrence) {
        try { assertRunnableSession(bundle.tab, timer); }
        catch (error) {
          status = "blocked";
          code = error instanceof TimerServiceError ? error.code : "SESSION_NOT_READY";
        }
        if (status === "queued" && hasActiveTimerBatch(bundle.prompts, timer)) status = "coalesced";
        if (status === "queued") {
          batchIds = await this.materializePrompts(tabId, bundle.prompts, timer, occurrenceId, triggeredAt, true);
        }
      } else {
        batchIds = deterministicIds.filter((id) => {
          const prompt = bundle.prompts.prompts.find((item) => item.id === id);
          return prompt?.status === "pending" && prompt.timerAutoRun === true;
        });
      }

      const advanced = advanceTimer(timer, now);
      const updated: Timer = {
        ...advanced,
        lastTrigger: { occurrenceId, source: "scheduled", scheduledFor, triggeredAt, status, code },
        updatedAt: triggeredAt,
      };
      const timers = [...file.timers];
      timers[index] = updated;
      const next: TimerFile = { schemaVersion: 1, updatedAt: triggeredAt, timers };
      await this.storage.writeTimers(tabId, next);
      this.remember(tabId, next);
    });
    if (batchIds.length) await this.runnerForTab(tabId).runOneShotBatch(batchIds);
  }

  private async materializePrompts(
    tabId: string,
    prompts: PromptFile,
    timer: Timer,
    occurrenceId: string,
    timestamp: string,
    autoRun: boolean,
  ): Promise<string[]> {
    const ids = timer.prompts.map((template) => timerPromptId(occurrenceId, template.id));
    const existing = new Set(prompts.prompts.map((prompt) => prompt.id));
    const records = timer.prompts.flatMap((template, index) => {
      if (existing.has(ids[index])) return [];
      const prompt = newPrompt(template.text, "timer");
      prompt.id = ids[index];
      prompt.threadId = timer.threadId;
      prompt.timerId = timer.id;
      prompt.timerOccurrenceId = occurrenceId;
      if (autoRun) prompt.timerAutoRun = true;
      prompt.createdAt = timestamp;
      prompt.updatedAt = timestamp;
      return [prompt];
    });
    if (!records.length) return ids;
    const insertionIndex = timer.externalQueuePolicy === "priority"
      ? firstPendingIndex(prompts.prompts, timer.threadId)
      : afterPendingIndex(prompts.prompts, timer.threadId);
    prompts.prompts.splice(insertionIndex, 0, ...records);
    prompts.revision += 1;
    prompts.updatedAt = timestamp;
    await this.storage.writePrompts(tabId, prompts);
    return ids;
  }

  private async recoverAutoRuns(tabId: string): Promise<void> {
    if (this.detaching.has(tabId)) return;
    let runnable: string[] = [];
    await this.storage.withTabLock(tabId, async () => {
      if (this.detaching.has(tabId)) return;
      const bundle = await this.storage.readTab(tabId);
      this.refreshPromptActivity(tabId, bundle.prompts);
      const threadId = bundle.tab.session.threadId;
      if (bundle.tab.session.state !== "ready" || bundle.tab.session.provider === "shell" || !threadId || !bundle.tab.session.workingDirectory) return;
      const interruptedOccurrences = new Set(bundle.prompts.prompts
        .filter((prompt) => prompt.origin === "timer" && prompt.status === "interrupted" && prompt.error?.code === "SERVICE_RESTARTED")
        .map((prompt) => prompt.timerOccurrenceId)
        .filter((id): id is string => Boolean(id)));
      let changed = false;
      for (const prompt of bundle.prompts.prompts) {
        if (prompt.timerAutoRun !== true) continue;
        const valid = prompt.origin === "timer" && prompt.status === "pending" && prompt.threadId === threadId;
        const pausedByFailure = bundle.runtime.queueConfig.onFailure === "pause"
          && Boolean(prompt.timerOccurrenceId && interruptedOccurrences.has(prompt.timerOccurrenceId));
        if (valid && !pausedByFailure) runnable.push(prompt.id);
        else {
          delete prompt.timerAutoRun;
          prompt.updatedAt = isoNow();
          changed = true;
        }
      }
      if (changed) {
        bundle.prompts.revision += 1;
        bundle.prompts.updatedAt = isoNow();
        await this.storage.writePrompts(tabId, bundle.prompts);
      }
    });
    if (runnable.length) await this.runnerForTab(tabId).runOneShotBatch(runnable);
  }

  private onPromptDelta(tabId: string, delta: PromptDelta): void {
    if (!this.loadedTabs.has(tabId)) return;
    const active = this.activeTimerPromptIds.get(tabId) ?? new Set<string>();
    for (const id of delta.deletedIds) active.delete(id);
    for (const prompt of delta.upserts) {
      if (needsTimerHold(prompt)) active.add(prompt.id);
      else active.delete(prompt.id);
    }
    this.activeTimerPromptIds.set(tabId, active);
    this.updateBackgroundHold();
  }

  private refreshPromptActivity(tabId: string, prompts: PromptFile): void {
    this.activeTimerPromptIds.set(tabId, new Set(prompts.prompts.filter(needsTimerHold).map((prompt) => prompt.id)));
    this.updateBackgroundHold();
  }

  private updateBackgroundHold(): void {
    const enabled = [...this.files.values()].some((file) => file.timers.some((timer) => timer.enabled));
    const active = [...this.activeTimerPromptIds.values()].some((ids) => ids.size > 0);
    this.setBackgroundHold("timers", enabled || active);
  }

  private async ensureTab(tabId: string): Promise<void> {
    if (!await this.storage.tabExists(tabId)) throw new TimerServiceError(404, "TAB_NOT_FOUND", "Conversation not found.");
  }

  private assertAttached(tabId: string): void {
    if (this.detaching.has(tabId)) throw new TimerServiceError(409, "TAB_DELETING", "Conversation is being deleted.");
  }
}

export function timerOccurrenceId(timerId: string, scheduledFor: string): string {
  return `toc_${digest(`${timerId}\0${scheduledFor}`)}`;
}

export function timerPromptId(occurrenceId: string, templateId: string): string {
  return `tpr_${digest(`${occurrenceId}\0${templateId}`)}`;
}

export function timerFileEtag(file: TimerFile): string {
  return entityTag(JSON.stringify({ data: file }));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function assertPrecondition(header: string | string[] | undefined, currentEtag: string): void {
  if (header === undefined) throw new TimerServiceError(428, "PRECONDITION_REQUIRED", "Send If-Match from the latest timer response.");
  if (!ifMatchSatisfied(header, currentEtag)) throw new TimerServiceError(412, "PRECONDITION_FAILED", "Timer settings changed elsewhere. Refresh and retry.");
}

function parseDraft(input: unknown): z.output<typeof TimerDraftSchema> {
  try { return TimerDraftSchema.parse(input); }
  catch (error) {
    if (error instanceof z.ZodError && error.issues.some((issue) => issue.path.join(".") === "schedule.every")) {
      throw new TimerServiceError(422, "INVALID_TIMER", "The interval must be a positive whole number.");
    }
    if (error instanceof z.ZodError) {
      throw new TimerServiceError(422, "INVALID_TIMER", error.issues[0]?.message ?? "Invalid timer.");
    }
    throw new TimerServiceError(422, "INVALID_TIMER", error instanceof Error ? error.message : "Invalid timer.");
  }
}

function normalizeDraftRule(schedule: unknown, now: Date) {
  try { return normalizeTimerRule(schedule, now, { rejectPastOnce: true }); }
  catch (error) { throw new TimerServiceError(422, "INVALID_TIMER_SCHEDULE", error instanceof Error ? error.message : "Invalid timer schedule."); }
}

function normalizeTemplates(items: Array<{ id?: string; text: string }>): Timer["prompts"] {
  const used = new Set<string>();
  return items.map((item) => {
    const id = item.id && !used.has(item.id) ? item.id : randomUUID();
    used.add(id);
    return { id, text: item.text.trim() };
  });
}

function executableThread(tab: TabMeta): string {
  if (tab.session.provider === "shell" || !tab.session.threadId) {
    throw new TimerServiceError(409, "SESSION_NOT_CONFIGURED", "Connect a coding-agent conversation before creating or rebinding a timer.");
  }
  return tab.session.threadId;
}

function assertRunnableSession(tab: TabMeta, timer: Timer): void {
  if (tab.session.provider === "shell") throw new TimerServiceError(409, "UNSUPPORTED_PROVIDER", "Shell conversations cannot run timer prompts.");
  if (tab.session.state !== "ready" || !tab.session.threadId || !tab.session.workingDirectory) {
    throw new TimerServiceError(409, "SESSION_NOT_READY", "Open this coding-agent conversation before running its timer.");
  }
  if (tab.session.threadId !== timer.threadId) throw new TimerServiceError(409, "SESSION_CHANGED", "This timer is bound to a different conversation. Rebind it first.");
}

function hasActiveTimerBatch(prompts: PromptFile, timer: Timer): boolean {
  return prompts.prompts.some((prompt) => prompt.origin === "timer"
    && prompt.timerId === timer.id
    && prompt.threadId === timer.threadId
    && ACTIVE_STATUSES.has(prompt.status));
}

function advanceTimer(timer: Timer, now: Date): Timer {
  if (timer.schedule.kind === "once") return { ...timer, enabled: false, nextRunAt: null };
  const nextRunAt = nextTimerRunAt(timer.schedule, now);
  return { ...timer, enabled: nextRunAt !== null, nextRunAt };
}

function firstPendingIndex(prompts: readonly PromptRecord[], threadId: string): number {
  const index = prompts.findIndex((prompt) => prompt.status === "pending" && (!prompt.threadId || prompt.threadId === threadId));
  return index < 0 ? prompts.length : index;
}

function afterPendingIndex(prompts: readonly PromptRecord[], threadId: string): number {
  let index = -1;
  prompts.forEach((prompt, candidate) => {
    if (prompt.status === "pending" && (!prompt.threadId || prompt.threadId === threadId)) index = candidate;
  });
  return index < 0 ? prompts.length : index + 1;
}

function needsTimerHold(prompt: PromptRecord): boolean {
  return prompt.timerAutoRun === true || (prompt.origin === "timer" && (prompt.status === "dispatching" || prompt.status === "running"));
}
