import { z } from "zod";

export const isoNow = () => new Date().toISOString();
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

// "shell" is a conversation with no coding agent at all: just a PowerShell in
// a working directory. Turns, final answers and history do not apply to it.
//
// "e2ee" is not a conversation either: it is the end-to-end encryption switch
// wearing a tab's clothes, so that turning encryption on and off is the same
// gesture as opening and deleting a conversation. It has no terminal, no queue
// and no history, and its working directory field holds the passphrase, which
// never leaves this machine (see docs/P2P_E2EE_MINIMAL_DESIGN.md).
export const AgentProviderSchema = z.enum(["codex", "claude", "cursor", "shell", "e2ee"]);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

export const OriginSchema = z.enum(["queue", "manual", "imported", "timer"]);
export type Origin = z.infer<typeof OriginSchema>;

export const PromptStatusSchema = z.enum([
  "pending",
  "dispatching",
  "running",
  "completed",
  "failed",
  "interrupted",
  "skipped",
]);
export type PromptStatus = z.infer<typeof PromptStatusSchema>;

export const AttemptSchema = z.object({
  attemptId: z.string(),
  origin: OriginSchema,
  delivery: z.enum(["turn", "steer"]).default("turn"),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  status: PromptStatusSchema,
  codexTurnId: z.string().nullable(),
  clientUserMessageId: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PromptAttempt = z.infer<typeof AttemptSchema>;

export const PromptSchema = z.object({
  id: z.string(),
  text: z.string(),
  status: PromptStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  origin: OriginSchema,
  threadId: z.string().nullable().default(null),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  codexTurnId: z.string().nullable(),
  clientUserMessageId: z.string().nullable(),
  attempts: z.array(AttemptSchema),
  inputSnapshot: z.array(z.unknown()).optional(),
  timerId: z.string().optional(),
  timerOccurrenceId: z.string().optional(),
  timerAutoRun: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type PromptRecord = z.infer<typeof PromptSchema>;

export const PromptFileSchema = z.object({
  schemaVersion: z.number().default(1),
  revision: z.number().default(0),
  updatedAt: z.string().default(isoNow),
  prompts: z.array(PromptSchema).default([]),
});
export type PromptFile = z.infer<typeof PromptFileSchema>;

export const AnswerStatusSchema = z.enum(["running", "completed", "interrupted", "failed"]);
export type AnswerStatus = z.infer<typeof AnswerStatusSchema>;

export const AnswerSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  threadId: z.string(),
  codexTurnId: z.string(),
  origin: OriginSchema,
  prompt: z.string(),
  status: AnswerStatusSchema.default("completed"),
  finalAnswer: z.string().default(""),
  captureMode: z.enum(["phase_final_answer", "fallback_last_agent_message", "fallback_plan", "fallback_partial_answer", "manual_text"]).nullable().default(null),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  recordedAt: z.string(),
  clientUserMessageId: z.string().nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type AnswerRecord = z.infer<typeof AnswerSchema>;

export const AnswerFileSchema = z.object({
  schemaVersion: z.number().default(1),
  revision: z.number().default(0),
  updatedAt: z.string().default(isoNow),
  answers: z.array(AnswerSchema).default([]),
});
export type AnswerFile = z.infer<typeof AnswerFileSchema>;

export const SessionSchema = z.object({
  // Existing v1 tabs did not persist a provider and are Codex conversations.
  // The default keeps those files readable without a destructive migration.
  provider: AgentProviderSchema.default("codex"),
  state: z.enum(["unconfigured", "connecting", "ready", "closed", "error"]),
  reopenOnLaunch: z.boolean().default(false),
  workingDirectory: z.string().nullable(),
  threadId: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(),
  lastThreadSwitch: z.object({
    fromThreadId: z.string(),
    toThreadId: z.string(),
    method: z.enum(["thread/start", "thread/resume", "thread/fork", "session/start"]),
    switchedAt: z.string(),
  }).nullable().default(null),
  // Everything a remote page needs to derive the same key, and nothing it must
  // not have. The passphrase lives in workingDirectory and is stripped on the
  // way out; these three are not secret and must go out, because without the
  // salt the other side cannot derive anything at all.
  e2ee: z.object({
    salt: z.string(),
    iterations: z.number().int().positive(),
    fingerprint: z.string(),
  }).nullable().default(null),
});
export type Session = z.infer<typeof SessionSchema>;

export const TabMetaSchema = z.object({
  id: z.string(),
  name: z.string(),
  groupId: z.string().nullable(),
  order: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  session: SessionSchema,
  layout: z.object({ leftWidthPercent: z.number().min(20).max(80) }).default({ leftWidthPercent: 42 }),
});
export type TabMeta = z.infer<typeof TabMetaSchema>;

export const RunnerStateSchema = z.enum([
  "paused",
  "starting",
  "waiting_for_thread",
  "dispatching",
  "reconciling",
  "running",
  "waiting_for_prompt",
  "pausing",
  "error",
]);
export type RunnerState = z.infer<typeof RunnerStateSchema>;

export const AppServerOwnershipSchema = z.object({
  launcherPid: z.number().int().positive().nullable(),
  listenerPid: z.number().int().positive().nullable(),
  port: z.number().int().min(1).max(65_535),
  startedAt: z.string(),
});
export type AppServerOwnership = z.infer<typeof AppServerOwnershipSchema>;

export const RuntimeFileSchema = z.object({
  schemaVersion: z.number().default(1),
  revision: z.number().default(0),
  runner: z.object({
    // Three states, not two. "armed" is idle like "paused", but adding a prompt
    // starts the queue instead of only queueing it -- that difference is the
    // whole point of separating them, and existing files default to "paused"
    // so a conversation from before this split never starts on its own.
    desiredState: z.enum(["paused", "armed", "running"]).default("paused"),
    state: RunnerStateSchema.default("paused"),
    activePromptId: z.string().nullable().default(null),
    activeTurnId: z.string().nullable().default(null),
    lastError: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
    // When the running turn last recorded anything, set only once it has been
    // quiet long enough to be worth saying so. Never changes the turn's state:
    // a stalled turn is still running as far as everything else is concerned.
    stalledSince: z.string().nullable().default(null),
    lastTransitionAt: z.string().default(isoNow),
  }).default({
    desiredState: "paused",
    state: "paused",
    activePromptId: null,
    activeTurnId: null,
    lastError: null,
    stalledSince: null,
    lastTransitionAt: isoNow(),
  }),
  terminal: z.object({
    state: z.enum(["stopped", "starting", "running", "exited", "error"]).default("stopped"),
    lastExitCode: z.number().nullable().default(null),
    lastStartedAt: z.string().nullable().default(null),
    lastError: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
    appServer: AppServerOwnershipSchema.nullable().default(null),
    cols: z.number().int().min(20).max(500).nullable().default(null),
    rows: z.number().int().min(5).max(200).nullable().default(null),
  }).default({ state: "stopped", lastExitCode: null, lastStartedAt: null, lastError: null, appServer: null, cols: null, rows: null }),
  reconciliation: z.object({
    required: z.boolean().default(false),
    lastCompletedAt: z.string().nullable().default(null),
  }).default({ required: false, lastCompletedAt: null }),
  queueConfig: z.object({
    onFailure: z.enum(["pause", "continue"]).default("pause"),
  }).default({ onFailure: "pause" }),
});
export type RuntimeFile = z.infer<typeof RuntimeFileSchema>;

export const GroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number(),
  collapsed: z.boolean().default(false),
});
export type Group = z.infer<typeof GroupSchema>;

export const IndexFileSchema = z.object({
  schemaVersion: z.number().default(1),
  revision: z.number().default(0),
  updatedAt: z.string().default(isoNow),
  groups: z.array(GroupSchema).default([]),
  tabs: z.array(TabMetaSchema).default([]),
  ui: z.object({
    consoleWidth: z.number().min(220).max(520).default(300),
    theme: z.enum(["light", "dark"]).default("light"),
    locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
    ungroupedCollapsed: z.boolean().default(false),
    // Written once, when the app shuts down, purely so the next launch knows
    // which conversation to bring back first. Never read by the UI.
    lastSelectedTabId: z.string().nullable().default(null),
  }).default({ consoleWidth: 300, theme: "light", locale: "zh-CN", ungroupedCollapsed: false, lastSelectedTabId: null }),
});
export type IndexFile = z.infer<typeof IndexFileSchema>;

export const MAX_TIMERS_PER_TAB = 50;
export const MAX_TIMER_PROMPTS = 20;
export const MAX_COMMON_PROMPTS = 200;
export const MAX_PROMPT_TEXT_BYTES = 128 * 1024;
export const MAX_TIMER_REQUEST_BYTES = 512 * 1024;
export const MAX_AUXILIARY_FILE_BYTES = 1024 * 1024;

const TimerPromptTemplateSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type TimerPromptTemplate = z.infer<typeof TimerPromptTemplateSchema>;

export const OnceScheduleSchema = z.object({
  kind: z.literal("once"),
  localDateTime: z.string(),
});

export const WeeklyScheduleSchema = z.object({
  kind: z.literal("weekly"),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  localTime: z.string(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
});

export const IntervalScheduleSchema = z.object({
  kind: z.literal("interval"),
  // Drafts may contain more precision; the server stores this value rounded
  // to two decimals and converts the recurrence to a whole-minute step.
  every: z.number().positive(),
  unit: z.enum(["hours", "days"]),
  anchorAt: z.string(),
  endAt: z.string().nullable(),
});

export const TimerScheduleSchema = z.discriminatedUnion("kind", [
  OnceScheduleSchema,
  WeeklyScheduleSchema,
  IntervalScheduleSchema,
]);
export type TimerSchedule = z.infer<typeof TimerScheduleSchema>;

export const TimerLastTriggerSchema = z.object({
  occurrenceId: z.string(),
  source: z.enum(["scheduled", "manual"]),
  scheduledFor: z.string(),
  triggeredAt: z.string(),
  status: z.enum(["queued", "coalesced", "blocked"]),
  code: z.string().nullable(),
});
export type TimerLastTrigger = z.infer<typeof TimerLastTriggerSchema>;

export const TimerSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  threadId: z.string().min(1),
  enabled: z.boolean(),
  timeZone: z.string().min(1),
  externalQueuePolicy: z.enum(["priority", "after_running_queue"]),
  schedule: TimerScheduleSchema,
  prompts: z.array(TimerPromptTemplateSchema).min(1).max(MAX_TIMER_PROMPTS),
  nextRunAt: z.string().nullable(),
  lastTrigger: TimerLastTriggerSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Timer = z.infer<typeof TimerSchema>;

export const TimerFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  updatedAt: z.string().nullable().default(null),
  timers: z.array(TimerSchema).max(MAX_TIMERS_PER_TAB).default([]),
});
export type TimerFile = z.infer<typeof TimerFileSchema>;

export const CommonPromptSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  text: z.string().min(1),
});
export type CommonPrompt = z.infer<typeof CommonPromptSchema>;

export const CommonPromptFileSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  updatedAt: z.string().nullable().default(null),
  items: z.array(CommonPromptSchema).max(MAX_COMMON_PROMPTS).default([]),
});
export type CommonPromptFile = z.infer<typeof CommonPromptFileSchema>;

export const defaultTimerFile = (): TimerFile => ({ schemaVersion: 1, updatedAt: null, timers: [] });
export const defaultCommonPromptFile = (): CommonPromptFile => ({ schemaVersion: 1, updatedAt: null, items: [] });

export type TabBundle = {
  tab: TabMeta;
  prompts: PromptFile;
  answers: AnswerFile;
  runtime: RuntimeFile;
  /** Present on bandwidth-bounded reads; omitted by internal full-file reads. */
  window?: {
    prompts: { start: number; total: number; completed: number };
    answers: { start: number; total: number };
  };
};

export type TabRecordPage<T> = {
  records: T[];
  start: number;
  total: number;
  revision: number;
  updatedAt: string;
};

export const defaultSession = (): Session => ({
  provider: "codex",
  state: "unconfigured",
  reopenOnLaunch: false,
  workingDirectory: null,
  threadId: null,
  sessionId: null,
  createdAt: null,
  connectedAt: null,
  lastError: null,
  lastThreadSwitch: null,
  e2ee: null,
});

export const defaultRuntime = (): RuntimeFile => RuntimeFileSchema.parse({
  schemaVersion: 1,
  revision: 0,
  runner: {
    // A new conversation is armed: the first prompt added to it runs.
    desiredState: "armed",
    state: "paused",
    activePromptId: null,
    activeTurnId: null,
    lastError: null,
    lastTransitionAt: isoNow(),
  },
  terminal: { state: "stopped", lastExitCode: null, lastStartedAt: null, lastError: null, appServer: null, cols: null, rows: null },
  reconciliation: { required: false, lastCompletedAt: null },
});

export const defaultPromptFile = (): PromptFile => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: isoNow(),
  prompts: [],
});

export const defaultAnswerFile = (): AnswerFile => ({
  schemaVersion: 1,
  revision: 0,
  updatedAt: isoNow(),
  answers: [],
});

export const newPrompt = (text: string, origin: Origin = "queue"): PromptRecord => ({
  id: makeId(),
  text,
  status: "pending",
  createdAt: isoNow(),
  updatedAt: isoNow(),
  origin,
  threadId: null,
  startedAt: null,
  completedAt: null,
  codexTurnId: null,
  clientUserMessageId: null,
  attempts: [],
  inputSnapshot: undefined,
  error: null,
});

export const newAttempt = (origin: Origin = "queue"): PromptAttempt => ({
  attemptId: makeId(),
  origin,
  delivery: "turn",
  startedAt: null,
  completedAt: null,
  status: "pending",
  codexTurnId: null,
  clientUserMessageId: null,
  error: null,
});
