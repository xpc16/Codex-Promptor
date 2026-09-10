import { promises as fs } from "node:fs";
import path from "node:path";
import {
  A2A_SKILL_NAME_PATTERN,
  DEFAULT_A2A_LIMITS,
  a2aSnapshot,
  a2aTabSummary,
  type A2aBudgetSnapshot,
  type A2aPromptMeta,
  type A2aRootSummary,
  type A2aTabSummary,
} from "../shared/a2a.js";
import { isoNow, type AnswerRecord, type PromptRecord, type TabMeta } from "../shared/schemas.js";
import { A2aSkillError, parseSkillDocument, resolveRolePolicy, type A2aOp, type A2aSkill } from "./a2a-policy.js";
import { buildA2aPreamble, composeSubmittedText } from "./a2a-preamble.js";
import { A2aStore, paramsDigest, receiptKey, type A2aRoot } from "./a2a-store.js";
import type { StorageService } from "./storage.js";

/**
 * The one A2A entry point, behind the one A2A endpoint.
 *
 * Every verb here goes through the same three gates in the same order:
 * identity (which lease is calling), context (is that lease's current turn the
 * one it claims), and root (does this collaboration still accept work). The
 * budget is only ever spent after all three pass, and only inside the root
 * lock -- so two concurrent sends cannot both see the last free message.
 */

export type A2aDeliveryState = "queued" | "waitingForStart";

export class A2aError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly retryable = false,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "A2aError";
  }
}

/** What the caller's lease proved, before anything about the request is trusted. */
export type A2aCaller = { tabId: string; provider: "codex" | "claude" | "cursor" };

type A2aContext = {
  contextId: string;
  tabId: string;
  rootId: string;
  promptId: string;
  threadId: string;
  depth: number;
  role: string;
  level: number;
};

export type A2aDeps = {
  storage: StorageService;
  rootDir: string;
  enabled: () => boolean;
  /** Appends one A2A prompt to a target conversation's queue, with the target-state rules of the design's 3.2 table. */
  enqueue: (targetTabId: string, text: string, meta: A2aPromptMeta) => Promise<{ promptId: string; delivery: A2aDeliveryState; threadId: string }>;
  /** Re-sends the affected conversation's snapshot, so the collaboration is visible without a refresh. */
  notifyTab: (tabId: string) => void;
};

const AGENT_PROVIDERS = new Set(["codex", "claude", "cursor"]);
const MAX_REQUEST_TEXT_BYTES = 8 * 1024;
const MAX_READ_RECORDS = 20;
const DEFAULT_READ_RECORDS = 3;
const MAX_READ_RESPONSE_BYTES = 64 * 1024;

export class A2aService {
  readonly store: A2aStore;
  private readonly skillsDir: string;
  private readonly skillCache = new Map<string, { mtimeMs: number; skill: A2aSkill }>();
  /** Live dispatch contexts, keyed by attempt id. A restart clears them, which is the intent. */
  private readonly contexts = new Map<string, A2aContext>();
  /** Inbound message times per target, for the per-minute limit. Deliberately in memory. */
  private readonly inbound = new Map<string, number[]>();

  constructor(private readonly deps: A2aDeps) {
    this.store = new A2aStore(deps.storage);
    this.skillsDir = path.join(deps.rootDir, "a2a", "skills");
  }

  // ---------------------------------------------------------------- skills

  async loadSkill(name: string): Promise<A2aSkill> {
    if (!A2A_SKILL_NAME_PATTERN.test(name)) {
      throw new A2aError("A2A_SKILL_NOT_FOUND", 400, `协作模式名 ${name} 不合法，只允许小写字母、数字、- 和 _。`);
    }
    const file = path.join(this.skillsDir, `${name}.md`);
    let stat;
    try { stat = await fs.stat(file); }
    catch { throw new A2aError("A2A_SKILL_NOT_FOUND", 400, `找不到协作模式 ${name}（应为 a2a/skills/${name}.md）。`); }
    const cached = this.skillCache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.skill;
    try {
      const skill = parseSkillDocument(name, await fs.readFile(file, "utf8"));
      this.skillCache.set(name, { mtimeMs: stat.mtimeMs, skill });
      return skill;
    } catch (error) {
      if (error instanceof A2aSkillError) throw new A2aError(error.code, 400, error.message);
      throw error;
    }
  }

  async listSkills(): Promise<string[]> {
    try {
      return (await fs.readdir(this.skillsDir))
        .filter((name) => name.endsWith(".md") && A2A_SKILL_NAME_PATTERN.test(name.slice(0, -3)))
        .map((name) => name.slice(0, -3))
        .sort();
    } catch { return []; }
  }

  // ----------------------------------------------------------------- roots

  /**
   * A user prompt beginning with `@@` becomes a root, still `pending`: it has
   * not started until it is dispatched, so the purple light does not come on
   * for something sitting in a paused queue.
   */
  async beginRoot(input: { originTabId: string; originPromptId: string; skillName: string }): Promise<A2aRoot> {
    const skill = await this.loadSkill(input.skillName);
    return this.store.withRootLock(input.originPromptId, async () => this.store.write({
      schemaVersion: 1,
      rootId: input.originPromptId,
      revision: 0,
      status: "pending",
      skill: skill.name,
      skillVersion: skill.version,
      skillBody: skill.body,
      policy: skill.policy,
      permissionMode: "soft",
      originTabId: input.originTabId,
      originPromptId: input.originPromptId,
      createdAt: isoNow(),
      startedAt: null,
      endedAt: null,
      endReason: null,
      limits: DEFAULT_A2A_LIMITS,
      usedMessages: 1,
      usedSpawns: 0,
      members: [],
      pendingFinish: null,
      receipts: [],
    }));
  }

  async readRoot(rootId: string): Promise<A2aRoot | null> {
    return this.store.read(rootId);
  }

  // ------------------------------------------------------------- dispatch

  /**
   * Called once per attempt, while the tab lock is held and before anything
   * reaches the CLI. Returns the text actually submitted, or null for an
   * ordinary prompt.
   *
   * This is also where the context is created: an environment variable alone
   * never grants A2A, only being the turn currently executing does.
   */
  async prepareDispatch(input: {
    tab: TabMeta;
    prompt: PromptRecord;
    attemptId: string;
    threadId: string;
  }): Promise<{ submittedText: string; a2a: A2aPromptMeta } | null> {
    if (!this.deps.enabled()) return null;
    // A conversation inside an unfinished collaboration is still in it, so a
    // prompt the reader types here belongs to it too -- otherwise answering
    // the agent's own question drops that turn out of the collaboration, with
    // no context to call the endpoint with and no instructions to follow.
    const meta = input.prompt.a2a ?? await this.continuationMeta(input.tab.id);
    if (!meta) return null;
    const root = await this.store.read(meta.rootId);
    if (!root) return null;
    if (root.status === "completed" || root.status === "stopped") return null;

    const started = await this.store.withRootLock(root.rootId, async () => {
      const current = await this.store.read(root.rootId);
      if (!current) return null;
      const isOrigin = current.originTabId === input.tab.id && current.originPromptId === input.prompt.id;
      const existing = this.store.member(current, input.tab.id);
      const role = existing?.role
        ?? (isOrigin ? current.policy.rootRole : current.policy.defaultRole);
      const level = existing?.level ?? (isOrigin ? 0 : 1);
      const joined = this.store.join(current, {
        tabId: input.tab.id,
        threadId: input.threadId,
        role,
        level,
        parentTabId: existing?.parentTabId ?? meta.fromTabId,
      });
      const next: A2aRoot = joined.status === "pending"
        ? { ...joined, status: "running", startedAt: joined.startedAt ?? isoNow() }
        : joined;
      return this.store.write(next);
    });
    if (!started) return null;

    const member = this.store.member(started, input.tab.id)!;
    const effective = resolveRolePolicy(started.policy, member.role, member.level);
    const snapshot = a2aSnapshot(started, meta.depth);
    const fromTab = meta.fromTabId ? await this.deps.storage.getTabMeta(meta.fromTabId).catch(() => null) : null;
    const preamble = buildA2aPreamble({
      contextId: input.attemptId,
      skillName: started.skill,
      skillBody: started.skillBody,
      role: member.role,
      level: member.level,
      permissionMode: started.permissionMode,
      effective,
      snapshot,
      helperCommand: `node "${path.join(this.deps.rootDir, "scripts", "a2a.mjs")}"`,
      selfTabId: input.tab.id,
      selfTabName: input.tab.name,
      from: fromTab && meta.fromPromptId
        ? { tabId: fromTab.id, tabName: fromTab.name, promptId: meta.fromPromptId }
        : null,
    });
    this.contexts.set(input.attemptId, {
      contextId: input.attemptId,
      tabId: input.tab.id,
      rootId: started.rootId,
      promptId: input.prompt.id,
      threadId: input.threadId,
      depth: meta.depth,
      role: member.role,
      level: member.level,
    });
    for (const participant of started.members) this.deps.notifyTab(participant.tabId);
    return { submittedText: composeSubmittedText(preamble, input.prompt.text), a2a: meta };
  }

  /**
   * The collaboration an ordinary prompt in this conversation belongs to, if
   * any: the most recently started root it has joined that has not ended. Its
   * depth is the depth of the last collaboration message this conversation
   * actually executed, so a reply the reader writes is bounded exactly as the
   * message it is replying to was.
   */
  private async continuationMeta(tabId: string): Promise<A2aPromptMeta | null> {
    const active = (await this.store.forTab(tabId))
      .filter((root) => root.status === "running" || root.status === "ending");
    const root = active[0];
    if (!root) return null;
    const prompts = await this.deps.storage.readPromptsOnly(tabId).catch(() => null);
    const previous = prompts?.prompts.filter((prompt) => prompt.a2a?.rootId === root.rootId).at(-1);
    return {
      rootId: root.rootId,
      skill: root.skill,
      depth: previous?.a2a?.depth ?? 0,
      fromTabId: null,
      fromPromptId: null,
    };
  }

  /**
   * A collaboration ends only when someone says so, and only after the turn
   * that said so has actually landed. This runs on ordinary queue activity,
   * so no timer or poller is needed to notice.
   */
  async onQueueEvent(tabId: string): Promise<void> {
    const roots = await this.store.forTab(tabId);
    for (const root of roots) {
      if (root.status !== "ending" || root.pendingFinish?.requestedBy !== tabId) continue;
      const attemptId = root.pendingFinish.attemptId;
      if (!attemptId) continue;
      const bundle = await this.deps.storage.readTab(tabId).catch(() => null);
      if (!bundle) continue;
      const prompt = bundle.prompts.prompts.find((item) => item.attempts.some((attempt) => attempt.attemptId === attemptId));
      // The prompt it was waiting for is gone -- deleted, or its conversation
      // rebuilt. There is nothing left to confirm, so settle rather than leave
      // the root saying "ending" with nothing on the way.
      if (prompt && ["dispatching", "running", "pending"].includes(prompt.status)) continue;
      const settled = await this.store.withRootLock(root.rootId, async () => {
        const current = await this.store.read(root.rootId);
        if (!current || current.status !== "ending" || current.pendingFinish?.attemptId !== attemptId) return null;
        // A stop settles however its turn ended -- interrupting it is one of
        // the ways a person stops a collaboration. Only a *completion* needs
        // its turn to have actually succeeded.
        if (!prompt || prompt.status === "completed" || current.pendingFinish.intent === "stop") {
          return this.store.write({
            ...current,
            status: current.pendingFinish.intent === "stop" ? "stopped" : "completed",
            endedAt: isoNow(),
            endReason: current.pendingFinish.reason,
            pendingFinish: null,
          });
        }
        // The turn that was going to confirm the end failed or was interrupted.
        // Withdrawing is the honest outcome: nothing confirmed anything.
        return this.store.write({ ...current, status: "running", endReason: "finish_confirmation_failed", pendingFinish: null });
      });
      if (settled) for (const participant of settled.members) this.deps.notifyTab(participant.tabId);
    }
  }

  /** Invalidates a context without waiting for storage to disagree with it. */
  releaseContext(attemptId: string): void {
    this.contexts.delete(attemptId);
  }

  releaseTabContexts(tabId: string): void {
    for (const [id, context] of this.contexts) if (context.tabId === tabId) this.contexts.delete(id);
  }

  // ------------------------------------------------------------- projection

  /** What a page needs to draw the purple light and the root's counters. Nothing frozen or secret. */
  async summaryForTab(tabId: string, tabState?: string): Promise<A2aTabSummary | undefined> {
    const roots = await this.store.forTab(tabId);
    if (!roots.length) return undefined;
    const summaries: A2aRootSummary[] = [];
    for (const root of roots.slice(0, 8)) {
      const member = this.store.member(root, tabId)!;
      const origin = await this.deps.storage.getTabMeta(root.originTabId).catch(() => null);
      const snapshot = a2aSnapshot(root, member.level);
      summaries.push({
        rootId: root.rootId,
        skill: root.skill,
        status: root.status,
        permissionMode: root.permissionMode,
        role: member.role,
        level: member.level,
        startedAt: root.startedAt,
        endedAt: root.endedAt,
        endReason: root.endReason,
        originTabId: root.originTabId,
        originTabName: origin?.name ?? root.originTabId,
        participants: root.members.length,
        limits: root.limits,
        usedMessages: root.usedMessages,
        remainingMessages: snapshot.budget.remainingMessages,
        usedSpawns: root.usedSpawns,
        advice: snapshot.advice,
        sessionClosed: (root.status === "running" || root.status === "ending") && tabState === "closed" ? true : undefined,
      });
    }
    return a2aTabSummary(summaries);
  }

  // ------------------------------------------------------------------ verbs

  async handle(caller: A2aCaller, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.deps.enabled()) throw new A2aError("A2A_DISABLED", 403, "A2A 未启用（CODEX_PROMPTOR_A2A=0）。");
    const op = String(body.op ?? "");
    const contextId = String(body.contextId ?? "");
    if (!contextId) throw new A2aError("A2A_CONTEXT_REQUIRED", 400, "缺少 contextId。");
    const { context, root } = await this.resolveContext(contextId, caller.tabId);
    switch (op) {
      case "list": return this.opList(context, root);
      case "read": return this.opRead(context, root, body);
      case "status": return this.opStatus(context, root, body);
      case "send": return this.opSend(context, root, body);
      case "finish": return this.opFinish(context, root, body);
      case "spawn": case "pause": case "resume": case "interrupt":
        throw new A2aError("A2A_OP_NOT_AVAILABLE", 400, `${op} 属于第二阶段，本版本未开放。`);
      default:
        throw new A2aError("A2A_OP_UNKNOWN", 400, `未知操作 ${op || "(空)"}。可用：list、read、status、send、finish。`);
    }
  }

  /**
   * The context is only valid while the attempt that owns it is the turn this
   * conversation is actually running. Storage is the authority, not the map:
   * an interrupted, superseded or thread-switched turn stops being A2A the
   * moment its prompt does.
   */
  private async resolveContext(contextId: string, tabId: string): Promise<{ context: A2aContext; root: A2aRoot }> {
    const context = this.contexts.get(contextId);
    if (!context || context.tabId !== tabId) {
      throw new A2aError("A2A_CONTEXT_INVALID", 403, "contextId 无效或不属于本对话。只有当前正在执行的 A2A 轮次可以调用。");
    }
    const bundle = await this.deps.storage.readTab(tabId).catch(() => null);
    if (!bundle || bundle.tab.session.state !== "ready" || bundle.tab.session.threadId !== context.threadId) {
      this.contexts.delete(contextId);
      throw new A2aError("A2A_CONTEXT_EXPIRED", 409, "会话已关闭或已切换对话，上下文失效。");
    }
    const prompt = bundle.prompts.prompts.find((item) => item.id === context.promptId);
    const active = prompt && ["dispatching", "running"].includes(prompt.status)
      && prompt.attempts[prompt.attempts.length - 1]?.attemptId === contextId;
    if (!active) {
      this.contexts.delete(contextId);
      throw new A2aError("A2A_CONTEXT_EXPIRED", 409, "本轮已结束或被中断，上下文失效。");
    }
    const root = await this.store.read(context.rootId);
    if (!root) throw new A2aError("A2A_ROOT_NOT_FOUND", 404, "协作记录不存在。");
    return { context, root };
  }

  private snapshotOf(root: A2aRoot, depth: number): A2aBudgetSnapshot {
    return a2aSnapshot(root, depth);
  }

  private async opList(context: A2aContext, root: A2aRoot): Promise<Record<string, unknown>> {
    const tabs = await this.deps.storage.listTabMeta();
    const conversations = [];
    for (const tab of tabs) {
      if (!AGENT_PROVIDERS.has(tab.session.provider)) continue;
      const runtime = await this.deps.storage.readRuntime(tab.id).catch(() => null);
      const prompts = await this.deps.storage.readPromptsOnly(tab.id).catch(() => null);
      conversations.push({
        tabId: tab.id,
        name: tab.name,
        groupId: tab.groupId,
        provider: tab.session.provider,
        deliverable: tab.session.state === "ready" && Boolean(tab.session.threadId),
        sessionState: tab.session.state,
        queued: prompts?.prompts.filter((prompt) => prompt.status === "pending").length ?? 0,
        runnerState: runtime?.runner.state ?? "unknown",
        self: tab.id === context.tabId,
        inRoot: root.members.some((member) => member.tabId === tab.id),
        role: this.store.member(root, tab.id)?.role ?? null,
      });
    }
    return { conversations, ...this.snapshotOf(root, context.depth) };
  }

  private async opRead(context: A2aContext, root: A2aRoot, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targetId = String(body.to ?? context.tabId);
    const tab = await this.requireAgentTab(targetId);
    const limit = Math.min(MAX_READ_RECORDS, Math.max(1, Number(body.limit ?? DEFAULT_READ_RECORDS) || DEFAULT_READ_RECORDS));
    const bundle = await this.deps.storage.readTab(targetId);
    const prompts = bundle.prompts;
    const answers = bundle.answers;
    const wanted = body.promptId ? String(body.promptId) : null;
    const chosenPrompts = (wanted ? prompts.prompts.filter((prompt) => prompt.id === wanted) : prompts.prompts).slice(-limit);
    const chosenAnswers = (wanted ? answers.answers.filter((answer) => answer.promptId === wanted) : answers.answers).slice(-limit);
    const payload = {
      tabId: targetId,
      name: tab.name,
      promptRevision: prompts.revision,
      answerRevision: answers.revision,
      prompts: chosenPrompts.map((prompt) => ({
        id: prompt.id,
        text: prompt.text,
        status: prompt.status,
        createdAt: prompt.createdAt,
        completedAt: prompt.completedAt,
        a2a: prompt.a2a ? { rootId: prompt.a2a.rootId, depth: prompt.a2a.depth, fromTabId: prompt.a2a.fromTabId } : null,
      })),
      answers: chosenAnswers.map((answer) => ({
        id: answer.id,
        promptId: answer.promptId,
        status: answer.status,
        startedAt: answer.startedAt,
        completedAt: answer.completedAt,
        finalAnswer: answer.finalAnswer,
      })),
    };
    return { ...truncateRead(payload), ...this.snapshotOf(root, context.depth) };
  }

  private async opStatus(context: A2aContext, root: A2aRoot, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const targetId = String(body.to ?? context.tabId);
    const tab = await this.requireAgentTab(targetId);
    const [runtime, prompts] = await Promise.all([
      this.deps.storage.readRuntime(targetId),
      this.deps.storage.readPromptsOnly(targetId),
    ]);
    const member = this.store.member(root, targetId);
    return {
      tabId: targetId,
      name: tab.name,
      sessionState: tab.session.state,
      runner: {
        desiredState: runtime.runner.desiredState,
        state: runtime.runner.state,
        activePromptId: runtime.runner.activePromptId,
      },
      queued: prompts.prompts.filter((prompt) => prompt.status === "pending").length,
      promptRevision: prompts.revision,
      role: member?.role ?? null,
      level: member?.level ?? null,
      root: {
        rootId: root.rootId,
        skill: root.skill,
        status: root.status,
        startedAt: root.startedAt,
        endedAt: root.endedAt,
        participants: root.members.length,
      },
      ...this.snapshotOf(root, context.depth),
    };
  }

  private async opSend(context: A2aContext, root: A2aRoot, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = String(body.requestId ?? "");
    if (!requestId) throw new A2aError("A2A_REQUEST_ID_REQUIRED", 400, "写操作需要 requestId；网络重试请复用同一个值。");
    const targetId = String(body.to ?? "");
    const text = String(body.text ?? "").trim();
    if (!text) throw new A2aError("A2A_TEXT_EMPTY", 400, "send 需要 text。");
    if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_TEXT_BYTES) {
      throw new A2aError("A2A_TEXT_TOO_LARGE", 413, `一条消息最多 ${MAX_REQUEST_TEXT_BYTES} 字节，请自行摘要。`);
    }
    if (targetId === context.tabId) throw new A2aError("A2A_TARGET_INVALID", 400, "不能给自己发消息。");
    await this.requireAgentTab(targetId);

    const key = receiptKey(context.tabId, context.contextId, requestId);
    const digest = paramsDigest({ op: "send", to: targetId, text });
    const replay = this.store.findReceipt(root, key);
    if (replay) {
      if (replay.digest !== digest) throw new A2aError("A2A_REQUEST_CONFLICT", 409, "同一个 requestId 带着不同的参数重发，这不是重试。");
      const current = (await this.store.read(root.rootId)) ?? root;
      return { ...replay.result, replayed: true, ...this.snapshotOf(current, context.depth) };
    }

    const depth = context.depth + 1;
    if (depth > root.limits.depth) {
      throw new A2aError("A2A_DEPTH_LIMIT", 429, `已达深度上限 ${root.limits.depth} 跳，本次发送被拒绝。请在本轮最终回答里写出阶段性结果。`, false, this.snapshotOf(root, context.depth));
    }
    const wait = this.rateLimitDelay(targetId, root.limits.inboundPerMinute);
    if (wait > 0) {
      throw new A2aError("A2A_RATE_LIMIT", 429, `目标对话每分钟最多接收 ${root.limits.inboundPerMinute} 条，请稍后重试同一请求。`, true, { retryAfterMs: wait, ...this.snapshotOf(root, context.depth) });
    }

    // Reserve inside the root lock, then write the target inside its own tab
    // lock. Two sends racing for the last message cannot both win, and a
    // failed delivery gives the reservation back rather than burning it.
    const reserved = await this.store.withRootLock(root.rootId, async () => {
      const current = await this.store.read(root.rootId);
      if (!current) throw new A2aError("A2A_ROOT_NOT_FOUND", 404, "协作记录不存在。");
      this.assertRootAcceptsWork(current);
      if (current.usedMessages >= current.limits.messages) {
        throw new A2aError("A2A_MESSAGE_LIMIT", 429, `本次协作的消息额度 ${current.limits.messages} 条已用尽，不再接受新消息。请完成本轮并写出阶段性结果。`, false, this.snapshotOf(current, context.depth));
      }
      return this.store.write({ ...current, usedMessages: current.usedMessages + 1 });
    });

    const meta: A2aPromptMeta = {
      rootId: root.rootId,
      skill: reserved.skill,
      depth,
      fromTabId: context.tabId,
      fromPromptId: context.promptId,
    };
    let delivered: { promptId: string; delivery: A2aDeliveryState; threadId: string };
    try {
      delivered = await this.deps.enqueue(targetId, text, meta);
    } catch (error) {
      await this.store.withRootLock(root.rootId, async () => {
        const current = await this.store.read(root.rootId);
        if (current) await this.store.write({ ...current, usedMessages: Math.max(0, current.usedMessages - 1) });
      });
      throw error;
    }

    const requestedRole = body.targetRole ? String(body.targetRole) : null;
    const finalRoot = await this.store.withRootLock(root.rootId, async () => {
      const current = (await this.store.read(root.rootId))!;
      const existing = this.store.member(current, targetId);
      const parent = this.store.member(current, context.tabId);
      const role = existing?.role
        ?? (requestedRole && current.policy.roles[requestedRole] ? requestedRole : current.policy.defaultRole);
      const joined = this.store.join(current, {
        tabId: targetId,
        threadId: delivered.threadId,
        role,
        level: existing?.level ?? (parent ? parent.level + 1 : 1),
        parentTabId: existing?.parentTabId ?? context.tabId,
      });
      const result = { delivered: { tabId: targetId, promptId: delivered.promptId, delivery: delivered.delivery } };
      return this.store.write(this.store.recordReceipt(joined, {
        key, op: "send", digest, resultId: delivered.promptId, result, at: isoNow(),
      }));
    });
    this.noteInbound(targetId);
    for (const participant of finalRoot.members) this.deps.notifyTab(participant.tabId);
    return {
      delivered: { tabId: targetId, promptId: delivered.promptId, delivery: delivered.delivery },
      note: delivered.delivery === "waitingForStart"
        ? "对方队列处于暂停状态，消息已保存但不会自动开始，需要用户在页面上启动。"
        : "已入队。这只表示对方收到了，不表示已经执行或成功完成。",
      ...this.snapshotOf(finalRoot, context.depth),
    };
  }

  private async opFinish(context: A2aContext, root: A2aRoot, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = String(body.requestId ?? "");
    if (!requestId) throw new A2aError("A2A_REQUEST_ID_REQUIRED", 400, "写操作需要 requestId；网络重试请复用同一个值。");
    if (context.tabId !== root.originTabId) {
      throw new A2aError("A2A_FINISH_NOT_OWNER", 403, "只有发起这项协作的对话可以结束它。完成你的分工并反馈即可。");
    }
    const reason = ["completed", "budget_limited", "depth_limited"].includes(String(body.reason ?? ""))
      ? String(body.reason)
      : "completed";
    const outstanding = await this.outstandingWork(root, context.promptId);
    const settled = await this.store.withRootLock(root.rootId, async () => {
      const current = await this.store.read(root.rootId);
      if (!current) throw new A2aError("A2A_ROOT_NOT_FOUND", 404, "协作记录不存在。");
      if (current.status === "completed" || current.status === "stopped") {
        return current;
      }
      if (current.status === "ending") {
        // An accepted request is idempotent; a second call just gets the receipt.
        return current;
      }
      if (outstanding.length) {
        throw new A2aError("A2A_FINISH_BLOCKED", 409, `还有 ${outstanding.length} 条本次协作的任务未结束，暂时不能宣告完成。`, false, { outstanding });
      }
      return this.store.write({
        ...current,
        status: "ending",
        pendingFinish: {
          intent: "complete",
          reason,
          requestedBy: context.tabId,
          attemptId: context.contextId,
          requestId,
          requestedAt: isoNow(),
        },
      });
    });
    for (const participant of settled.members) this.deps.notifyTab(participant.tabId);
    return {
      root: { rootId: settled.rootId, status: settled.status, endReason: settled.endReason ?? reason },
      note: "已接受完成请求。本轮最终回答落盘后，整项协作才会标记为已完成；在那之前不要再发送新消息。",
      ...this.snapshotOf(settled, context.depth),
    };
  }

  /**
   * User-driven end, from the page. Same lock and the same two-step settle, so
   * a model that is still writing is never reported as already finished.
   */
  async endRootFromUser(rootId: string, intent: "complete" | "stop"): Promise<A2aRoot> {
    const root = await this.store.read(rootId);
    if (!root) throw new A2aError("A2A_ROOT_NOT_FOUND", 404, "协作记录不存在。");
    // Stopping first removes work that has not started, so what is left is
    // only what is genuinely in flight. Doing this the other way round bound
    // the end to a queued item and then deleted it, leaving the root waiting
    // for a prompt that no longer existed.
    if (intent === "stop") await this.cancelPendingWork(root);
    const outstanding = (await this.outstandingWork(root, null))
      .filter((item) => intent !== "stop" || (item.status !== "pending" && item.attemptId));
    const settled = await this.store.withRootLock(rootId, async () => {
      const current = await this.store.read(rootId);
      if (!current) throw new A2aError("A2A_ROOT_NOT_FOUND", 404, "协作记录不存在。");
      if (current.status === "completed" || current.status === "stopped") return current;
      if (intent === "complete" && outstanding.length) {
        throw new A2aError("A2A_FINISH_BLOCKED", 409, `还有 ${outstanding.length} 条任务未结束，请先等待或使用「停止协作」。`, false, { outstanding });
      }
      // A second stop on a root that is already ending forces it. The turn it
      // was waiting for may never report -- a submission the CLI never
      // confirmed leaves one sitting in `dispatching` indefinitely -- and the
      // person's own control has to win over waiting for it.
      const forced = intent === "stop" && current.status === "ending";
      if (!outstanding.length || forced) {
        return this.store.write({
          ...current,
          status: intent === "stop" ? "stopped" : "completed",
          endedAt: isoNow(),
          endReason: forced ? "stopped_by_user_unconfirmed" : intent === "stop" ? "stopped_by_user" : "completed_by_user",
          pendingFinish: null,
        });
      }
      // Stop with work still running: refuse new work now, settle when it lands.
      return this.store.write({
        ...current,
        status: "ending",
        pendingFinish: {
          intent: "stop",
          reason: "stopped_by_user",
          requestedBy: outstanding[0].tabId,
          attemptId: outstanding[0].attemptId,
          requestId: null,
          requestedAt: isoNow(),
        },
      });
    });
    for (const participant of settled.members) this.deps.notifyTab(participant.tabId);
    return settled;
  }


  /** Every unfinished message of this root, anywhere, except the caller's own running turn. */
  private async outstandingWork(root: A2aRoot, exceptPromptId: string | null): Promise<Array<{ tabId: string; promptId: string; attemptId: string | null; status: string }>> {
    const outstanding = [];
    for (const member of root.members) {
      const prompts = await this.deps.storage.readPromptsOnly(member.tabId).catch(() => null);
      if (!prompts) continue;
      for (const prompt of prompts.prompts) {
        if (prompt.a2a?.rootId !== root.rootId) continue;
        if (prompt.id === exceptPromptId) continue;
        if (!["pending", "dispatching", "running"].includes(prompt.status)) continue;
        outstanding.push({
          tabId: member.tabId,
          promptId: prompt.id,
          attemptId: prompt.attempts[prompt.attempts.length - 1]?.attemptId ?? null,
          status: prompt.status,
        });
      }
    }
    return outstanding;
  }

  /** Stopping removes work that has not started. A running turn is left to the user's interrupt button. */
  private async cancelPendingWork(root: A2aRoot): Promise<void> {
    for (const member of root.members) {
      await this.deps.storage.withTabLock(member.tabId, async () => {
        const prompts = await this.deps.storage.readPromptsOnly(member.tabId).catch(() => null);
        if (!prompts) return;
        const before = prompts.prompts.length;
        prompts.prompts = prompts.prompts.filter((prompt) => !(prompt.a2a?.rootId === root.rootId && prompt.status === "pending"));
        if (prompts.prompts.length === before) return;
        prompts.revision += 1;
        prompts.updatedAt = isoNow();
        await this.deps.storage.writePrompts(member.tabId, prompts);
      }).catch(() => undefined);
    }
  }

  private assertRootAcceptsWork(root: A2aRoot): void {
    if (root.status === "ending") throw new A2aError("A2A_ROOT_ENDING", 409, "这项协作正在结束，不再接受新任务。");
    if (root.status === "completed" || root.status === "stopped") {
      throw new A2aError("A2A_ROOT_ENDED", 409, "这项协作已经结束，不再接受新任务。");
    }
  }

  private async requireAgentTab(tabId: string): Promise<TabMeta> {
    const tab = await this.deps.storage.getTabMeta(tabId).catch(() => null);
    if (!tab) throw new A2aError("A2A_TARGET_NOT_FOUND", 404, `找不到对话 ${tabId}。`);
    if (!AGENT_PROVIDERS.has(tab.session.provider)) {
      throw new A2aError("A2A_TARGET_NOT_AGENT", 400, "终端和加密开关不是 agent 对话，不能作为协作对象。");
    }
    return tab;
  }

  private rateLimitDelay(tabId: string, perMinute: number): number {
    const now = Date.now();
    const recent = (this.inbound.get(tabId) ?? []).filter((at) => now - at < 60_000);
    this.inbound.set(tabId, recent);
    if (recent.length < perMinute) return 0;
    return Math.max(1_000, 60_000 - (now - recent[0]));
  }

  private noteInbound(tabId: string): void {
    const now = Date.now();
    this.inbound.set(tabId, [...(this.inbound.get(tabId) ?? []).filter((at) => now - at < 60_000), now]);
  }
}

/**
 * A read that would not fit says where it stopped instead of quietly dropping
 * the tail. Truncating the answer text is enough: it is what makes a read big.
 */
function truncateRead(payload: {
  answers: Array<{ finalAnswer: string } & Record<string, unknown>>;
} & Record<string, unknown>): Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= MAX_READ_RESPONSE_BYTES) return payload;
  const budget = Math.max(512, Math.floor(MAX_READ_RESPONSE_BYTES / Math.max(1, payload.answers.length)) - 256);
  const answers = payload.answers.map((answer) => {
    const text = answer.finalAnswer ?? "";
    if (Buffer.byteLength(text, "utf8") <= budget) return answer;
    return { ...answer, finalAnswer: Buffer.from(text, "utf8").subarray(0, budget).toString("utf8"), truncated: true };
  });
  return { ...payload, answers, truncated: true, truncationNote: "最终回答已按字节上限截断，需要完整内容请按 id 逐条 read。" };
}

export type { PromptRecord, AnswerRecord };
