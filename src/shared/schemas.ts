import { z } from "zod";

export const isoNow = () => new Date().toISOString();
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export const OriginSchema = z.enum(["queue", "manual", "imported"]);
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

export const AnswerSchema = z.object({
  id: z.string(),
  promptId: z.string(),
  threadId: z.string(),
  codexTurnId: z.string(),
  origin: OriginSchema,
  prompt: z.string(),
  finalAnswer: z.string(),
  captureMode: z.enum(["phase_final_answer", "fallback_last_agent_message", "fallback_plan", "manual_text"]),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  recordedAt: z.string(),
  clientUserMessageId: z.string().nullable(),
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
    method: z.enum(["thread/start", "thread/resume", "thread/fork"]),
    switchedAt: z.string(),
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
    desiredState: z.enum(["paused", "running"]).default("paused"),
    state: RunnerStateSchema.default("paused"),
    activePromptId: z.string().nullable().default(null),
    activeTurnId: z.string().nullable().default(null),
    lastError: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
    lastTransitionAt: z.string().default(isoNow),
  }).default({
    desiredState: "paused",
    state: "paused",
    activePromptId: null,
    activeTurnId: null,
    lastError: null,
    lastTransitionAt: isoNow(),
  }),
  terminal: z.object({
    state: z.enum(["stopped", "starting", "running", "exited", "error"]).default("stopped"),
    lastExitCode: z.number().nullable().default(null),
    lastStartedAt: z.string().nullable().default(null),
    lastError: z.object({ code: z.string(), message: z.string() }).nullable().default(null),
    appServer: AppServerOwnershipSchema.nullable().default(null),
  }).default({ state: "stopped", lastExitCode: null, lastStartedAt: null, lastError: null, appServer: null }),
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
  }).default({ consoleWidth: 300, theme: "light", locale: "zh-CN", ungroupedCollapsed: false }),
});
export type IndexFile = z.infer<typeof IndexFileSchema>;

export type TabBundle = {
  tab: TabMeta;
  prompts: PromptFile;
  answers: AnswerFile;
  runtime: RuntimeFile;
};

export const defaultSession = (): Session => ({
  state: "unconfigured",
  reopenOnLaunch: false,
  workingDirectory: null,
  threadId: null,
  sessionId: null,
  createdAt: null,
  connectedAt: null,
  lastError: null,
  lastThreadSwitch: null,
});

export const defaultRuntime = (): RuntimeFile => RuntimeFileSchema.parse({
  schemaVersion: 1,
  revision: 0,
  runner: {
    desiredState: "paused",
    state: "paused",
    activePromptId: null,
    activeTurnId: null,
    lastError: null,
    lastTransitionAt: isoNow(),
  },
  terminal: { state: "stopped", lastExitCode: null, lastStartedAt: null, lastError: null, appServer: null },
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
  startedAt: null,
  completedAt: null,
  status: "pending",
  codexTurnId: null,
  clientUserMessageId: null,
  error: null,
});
