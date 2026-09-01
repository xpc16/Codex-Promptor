import { randomUUID } from "node:crypto";
import { isoNow, type AnswerRecord, type Origin, type PromptRecord, newPrompt, type TabBundle } from "../shared/schemas.js";
import { sameSubmittedPrompt } from "./prompt-submit.js";
import { StorageService } from "./storage.js";

const normalizeType = (value: unknown) => String(value ?? "").replace(/[_-]/g, "").toLowerCase();

function textFromValue(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join("");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.value === "string") return value.value;
  if (typeof value.content === "string" || Array.isArray(value.content)) return textFromValue(value.content);
  if (typeof value.message === "string" || Array.isArray(value.message)) return textFromValue(value.message);
  return "";
}

export function extractUserInput(items: any[]): { text: string; snapshot: unknown[] } | null {
  const users = items.filter((item) => ["usermessage", "userinput"].includes(normalizeType(item?.type)));
  if (!users.length) return null;
  const texts: string[] = [];
  const snapshot: unknown[] = [];
  for (const item of users) {
    const text = textFromValue(item?.text ?? item?.content ?? item?.message ?? item?.input);
    if (text) texts.push(text);
    snapshot.push(item);
  }
  if (!texts.length) {
    for (const item of users) {
      const descriptor = describeNonText(item);
      if (descriptor) texts.push(descriptor);
    }
  }
  return texts.length ? { text: texts.join("\n\n--- 追加输入 ---\n\n"), snapshot } : null;
}

function describeNonText(item: any): string {
  const parts = Array.isArray(item?.content) ? item.content : Array.isArray(item?.input) ? item.input : [];
  const descriptions = parts.map((part: any) => {
    const type = normalizeType(part?.type);
    if (type.includes("image") && part?.path) return `[localImage: ${part.path}]`;
    if (type.includes("image") && part?.url) return `[image: ${part.url}]`;
    if (type.includes("skill")) return `[skill: ${part.name ?? "unknown"}]`;
    if (type.includes("mention")) return `[mention: ${part.name ?? "unknown"}]`;
    if (part?.type) return `[${part.type}: unsupported]`;
    return "";
  }).filter(Boolean);
  return descriptions.join(" ");
}

export type FinalAnswer = { text: string; captureMode: AnswerRecord["captureMode"] } | null;

export function extractFinalAnswer(items: any[]): FinalAnswer {
  const agents = items.filter((item) => {
    const type = normalizeType(item?.type);
    return type === "agentmessage" || type === "assistantmessage";
  });
  const phaseFinal = agents.filter((item) => String(item?.phase ?? "").toLowerCase().replace(/[_-]/g, "") === "finalanswer");
  const finalText = textFromValue((phaseFinal.at(-1) ?? null)?.text ?? (phaseFinal.at(-1) ?? null)?.content ?? (phaseFinal.at(-1) ?? null)?.message);
  if (finalText) return { text: finalText, captureMode: "phase_final_answer" };
  // A turn that never reached a clean completion (e.g. a Claude transcript
  // with no end_turn) is tagged "partial_answer" by the importer. Surface it
  // distinctly from a genuine final answer so the UI can mark it as such.
  const phasePartial = agents.filter((item) => String(item?.phase ?? "").toLowerCase().replace(/[_-]/g, "") === "partialanswer");
  const partialText = textFromValue((phasePartial.at(-1) ?? null)?.text ?? (phasePartial.at(-1) ?? null)?.content ?? (phasePartial.at(-1) ?? null)?.message);
  if (partialText) return { text: partialText, captureMode: "fallback_partial_answer" };
  const lastAgent = agents.at(-1);
  const fallback = textFromValue(lastAgent?.text ?? lastAgent?.content ?? lastAgent?.message);
  if (fallback) return { text: fallback, captureMode: "fallback_last_agent_message" };
  const plan = items.filter((item) => normalizeType(item?.type) === "plan").at(-1);
  const planText = textFromValue(plan?.text ?? plan?.content ?? plan?.plan);
  return planText ? { text: planText, captureMode: "fallback_plan" } : null;
}

export const turnStatus = (turn: any): string => String(turn?.status?.type ?? turn?.status ?? turn?.state ?? "completed").toLowerCase();

export const turnCompleted = (turn: any): boolean => ["completed", "complete", "succeeded", "success"].includes(turnStatus(turn));

const terminalFailureStatus = (turn: any): "failed" | "interrupted" | null => {
  const status = turnStatus(turn);
  if (status === "failed") return "failed";
  return ["interrupted", "canceled", "cancelled"].includes(status) ? "interrupted" : null;
};

export function protocolTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || (typeof value === "string" && /^\d+(\.\d+)?$/.test(value))) {
    const number = Number(value);
    return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const RECOVERABLE_SUBMISSION_WINDOW_MS = 2 * 60_000;
const INTERRUPTED_SUBMISSION_PREFIX = "submission-interrupted:";

type RecoverableSubmission = {
  prompt: PromptRecord;
  attempt: PromptRecord["attempts"][number];
  previousTurnId: string | null;
};

/**
 * Finds one queue submission that reached the provider but lost its hook/turn
 * linkage. Text equivalence alone is not enough: the local attempt must still
 * have no provider turn (or only the synthetic interrupted-submission id), and
 * its start must be close to the provider turn. Ambiguity fails closed.
 */
function recoverableSubmissionForTurn(
  prompts: PromptRecord[],
  threadId: string,
  turn: any,
  inputText: string,
): RecoverableSubmission | null {
  const turnStartedAt = protocolTime(turn?.startedAt);
  const turnStartedMs = turnStartedAt ? Date.parse(turnStartedAt) : Number.NaN;
  if (!Number.isFinite(turnStartedMs)) return null;
  const matches: RecoverableSubmission[] = [];
  for (const prompt of prompts) {
    if ((prompt.origin !== "queue" && prompt.origin !== "timer")
      || (prompt.threadId && prompt.threadId !== threadId)
      || !["dispatching", "running", "interrupted"].includes(prompt.status)
      || !sameSubmittedPrompt(prompt.text, inputText)) continue;
    const previousTurnId = prompt.codexTurnId;
    if (previousTurnId && !previousTurnId.startsWith(INTERRUPTED_SUBMISSION_PREFIX)) continue;
    const attempt = [...prompt.attempts].reverse().find((item) => item.delivery === "turn"
      && ["dispatching", "running", "interrupted"].includes(item.status)
      && (!item.codexTurnId || item.codexTurnId.startsWith(INTERRUPTED_SUBMISSION_PREFIX)));
    if (!attempt) continue;
    const attemptStartedAt = protocolTime(attempt.startedAt ?? prompt.startedAt);
    const attemptStartedMs = attemptStartedAt ? Date.parse(attemptStartedAt) : Number.NaN;
    if (!Number.isFinite(attemptStartedMs) || Math.abs(turnStartedMs - attemptStartedMs) > RECOVERABLE_SUBMISSION_WINDOW_MS) continue;
    matches.push({ prompt, attempt, previousTurnId });
  }
  return matches.length === 1 ? matches[0] : null;
}

export type RecordTurnOptions = {
  threadId: string;
  turn: any;
  items: any[];
  origin: Origin;
  promptId?: string | null;
  promptText?: string;
  clientUserMessageId?: string | null;
};

function promptWasSteeredIntoTurn(prompt: PromptRecord, turnId: string): boolean {
  const attempts = prompt.attempts.filter((attempt) => attempt.codexTurnId === turnId);
  return attempts.some((attempt) => attempt.delivery === "steer")
    && !attempts.some((attempt) => attempt.delivery === "turn");
}

function combinedTurnPromptText(inputText: string | null | undefined, prompts: PromptRecord[]): string {
  const separator = "\n\n--- 追加输入 ---\n\n";
  const parts: string[] = [];
  const protocolText = inputText?.trim();
  if (protocolText) parts.push(protocolText);
  for (const prompt of prompts) {
    const text = prompt.text.trim();
    if (!text || parts.some((part) => part.includes(text) || sameSubmittedPrompt(part, text))) continue;
    parts.push(text);
  }
  return parts.join(separator);
}

function buildAnswerMetadata(prompts: PromptRecord[], turnId: string): Record<string, unknown> {
  return {
    promptIds: prompts.map((prompt) => prompt.id),
    steeredPromptIds: prompts.filter((prompt) => promptWasSteeredIntoTurn(prompt, turnId)).map((prompt) => prompt.id),
  };
}

function applyAnswerPatch(answer: AnswerRecord, patch: Partial<AnswerRecord>): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(patch) as Array<[keyof AnswerRecord, AnswerRecord[keyof AnswerRecord]]>) {
    if (JSON.stringify(answer[key]) === JSON.stringify(value)) continue;
    (answer as any)[key] = value;
    changed = true;
  }
  return changed;
}

export type RecordTurnStartedOptions = {
  threadId: string;
  turnId: string;
  promptId: string;
  promptText: string;
  startedAt: string | null;
  clientUserMessageId: string | null;
};

/** Persist the answer card as soon as Codex accepts a queued turn. */
export async function recordTurnStarted(storage: StorageService, tabId: string, options: RecordTurnStartedOptions): Promise<AnswerRecord> {
  return storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    const requested = bundle.prompts.prompts.find((prompt) => prompt.id === options.promptId);
    if (!requested) throw new Error("PROMPT_NOT_FOUND");
    const linked = bundle.prompts.prompts.filter((prompt) => prompt.codexTurnId === options.turnId && (!prompt.threadId || prompt.threadId === options.threadId));
    const primary = linked.find((prompt) => !promptWasSteeredIntoTurn(prompt, options.turnId)) ?? requested;
    const prompts = [primary, ...linked.filter((prompt) => prompt.id !== primary.id)];
    const promptText = combinedTurnPromptText(options.promptText, prompts);
    const metadata = buildAnswerMetadata(prompts, options.turnId);
    let answer = bundle.answers.answers.find((item) => item.threadId === options.threadId && item.codexTurnId === options.turnId);
    const now = isoNow();
    if (!answer) {
      answer = {
        id: randomUUID(),
        promptId: primary.id,
        threadId: options.threadId,
        codexTurnId: options.turnId,
        origin: primary.origin,
        prompt: promptText,
        status: "running",
        finalAnswer: "",
        captureMode: null,
        startedAt: options.startedAt ?? primary.startedAt,
        completedAt: null,
        recordedAt: now,
        clientUserMessageId: options.clientUserMessageId ?? primary.clientUserMessageId,
        error: null,
        metadata,
      };
      bundle.answers.answers.push(answer);
    } else if (answer.status === "running") {
      applyAnswerPatch(answer, {
        promptId: primary.id,
        origin: primary.origin,
        prompt: promptText,
        startedAt: answer.startedAt ?? options.startedAt ?? primary.startedAt,
        clientUserMessageId: answer.clientUserMessageId ?? options.clientUserMessageId ?? primary.clientUserMessageId,
        metadata,
      });
    } else {
      return answer;
    }
    bundle.answers.revision += 1;
    bundle.answers.updatedAt = now;
    await storage.writeAnswers(tabId, bundle.answers);
    return answer;
  });
}

export async function recordTurn(storage: StorageService, tabId: string, options: RecordTurnOptions): Promise<{ prompt: PromptRecord | null; answer: AnswerRecord | null }> {
  const turnId = String(options.turn?.id ?? options.turn?.turnId ?? "");
  if (!turnId) throw new Error("TURN_ID_MISSING");
  const input = extractUserInput(options.items);
  // Interrupted/failed turns can contain commentary agent messages. Those are
  // not final answers and must never make an unfinished queue item look done.
  const final = turnCompleted(options.turn) ? extractFinalAnswer(options.items) : null;
  const terminalStatus = terminalFailureStatus(options.turn);
  if (!input && !options.promptText) return { prompt: null, answer: null };
  return storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    // A completion event can arrive just after the terminal switched sessions.
    // Re-check under the tab lock so an old provider event cannot repopulate
    // prompt/final-answer JSON after the new history was reconciled.
    if (bundle.tab.session.threadId && bundle.tab.session.threadId !== options.threadId) {
      return { prompt: null, answer: null };
    }
    const linkedPrompts = bundle.prompts.prompts.filter((item) => item.codexTurnId === turnId && (!item.threadId || item.threadId === options.threadId));
    let prompt = (options.promptId ? bundle.prompts.prompts.find((item) => item.id === options.promptId) : undefined)
      ?? (options.clientUserMessageId ? bundle.prompts.prompts.find((item) => item.clientUserMessageId === options.clientUserMessageId) : undefined)
      ?? linkedPrompts.find((item) => !promptWasSteeredIntoTurn(item, turnId));
    const createdPrompt = !prompt;
    if (!prompt) {
      prompt = newPrompt(options.promptText ?? input?.text ?? "[无文本输入]", options.origin);
      prompt.inputSnapshot = input?.snapshot;
      bundle.prompts.prompts.push(prompt);
    } else if (!prompt.text && (options.promptText ?? input?.text)) {
      prompt.text = options.promptText ?? input?.text ?? prompt.text;
    }
    if (createdPrompt) prompt.origin = options.origin;
    prompt.threadId = options.threadId;
    prompt.codexTurnId = turnId;
    prompt.clientUserMessageId = options.clientUserMessageId ?? prompt.clientUserMessageId;
    prompt.startedAt = protocolTime(options.turn?.startedAt) ?? prompt.startedAt;
    prompt.updatedAt = isoNow();
    if (input?.snapshot && !prompt.inputSnapshot) prompt.inputSnapshot = input.snapshot;

    const protocolCompletedAt = protocolTime(options.turn?.completedAt);
    const completedAt = protocolCompletedAt ?? isoNow();
    const affectedPrompts = [prompt, ...linkedPrompts.filter((item) => item.id !== prompt.id)];
    const answerPrompt = combinedTurnPromptText(input?.text ?? options.promptText, affectedPrompts);
    const metadata = buildAnswerMetadata(affectedPrompts, turnId);
    const startedAt = protocolTime(options.turn?.startedAt) ?? prompt.startedAt;
    let answer: AnswerRecord | null = null;
    const ensureAnswer = (): AnswerRecord => {
      const existing = bundle.answers.answers.find((item) => item.threadId === options.threadId && item.codexTurnId === turnId);
      if (existing) return existing;
      const created: AnswerRecord = {
        id: randomUUID(),
        promptId: prompt.id,
        threadId: options.threadId,
        codexTurnId: turnId,
        origin: prompt.origin,
        prompt: answerPrompt,
        status: "running",
        finalAnswer: "",
        captureMode: null,
        startedAt,
        completedAt: null,
        recordedAt: isoNow(),
        clientUserMessageId: options.clientUserMessageId ?? prompt.clientUserMessageId,
        error: null,
        metadata,
      };
      bundle.answers.answers.push(created);
      return created;
    };
    if (final) {
      answer = ensureAnswer();
      // Codex completion snapshots can omit inputs delivered by turn/steer.
      // Local turn linkage is therefore also authoritative for the card summary.
      applyAnswerPatch(answer, {
        promptId: prompt.id,
        origin: prompt.origin,
        prompt: answerPrompt,
        status: "completed",
        finalAnswer: final.text,
        captureMode: final.captureMode,
        startedAt: startedAt ?? answer.startedAt,
        completedAt,
        clientUserMessageId: options.clientUserMessageId ?? prompt.clientUserMessageId,
        error: null,
        metadata,
      });
      for (const linked of affectedPrompts) {
        linked.threadId = options.threadId;
        linked.codexTurnId = turnId;
        linked.status = "completed";
        linked.completedAt = completedAt;
        linked.error = null;
        linked.updatedAt = isoNow();
        for (const attempt of linked.attempts.filter((item) => item.codexTurnId === turnId)) {
          attempt.status = "completed";
          attempt.completedAt = completedAt;
          attempt.error = null;
        }
      }
    } else if (terminalStatus) {
      const status = terminalStatus;
      const error = status === "interrupted"
        ? { code: "TURN_INTERRUPTED", message: "Agent turn was interrupted before a final answer was produced." }
        : { code: "TURN_FAILED", message: "Agent turn failed before a final answer was produced." };
      answer = ensureAnswer();
      applyAnswerPatch(answer, {
        promptId: prompt.id,
        origin: prompt.origin,
        prompt: answerPrompt,
        status,
        finalAnswer: "",
        captureMode: null,
        startedAt: startedAt ?? answer.startedAt,
        completedAt,
        clientUserMessageId: options.clientUserMessageId ?? prompt.clientUserMessageId,
        error,
        metadata,
      });
      for (const linked of affectedPrompts) {
        linked.threadId = options.threadId;
        linked.codexTurnId = turnId;
        linked.status = status;
        linked.completedAt = completedAt;
        linked.error = error;
        linked.updatedAt = isoNow();
        for (const attempt of linked.attempts.filter((item) => item.codexTurnId === turnId
          || (options.clientUserMessageId && item.clientUserMessageId === options.clientUserMessageId))) {
          attempt.status = status;
          attempt.completedAt = completedAt;
          attempt.error = error;
        }
      }
    } else if (options.origin === "queue" || options.origin === "timer") {
      const error = { code: "NO_FINAL_ANSWER", message: "Turn completed without a final answer." };
      answer = ensureAnswer();
      applyAnswerPatch(answer, {
        promptId: prompt.id,
        origin: prompt.origin,
        prompt: answerPrompt,
        status: "failed",
        finalAnswer: "",
        captureMode: null,
        startedAt: startedAt ?? answer.startedAt,
        completedAt,
        clientUserMessageId: options.clientUserMessageId ?? prompt.clientUserMessageId,
        error,
        metadata,
      });
      for (const linked of affectedPrompts) {
        linked.status = "failed";
        linked.completedAt = completedAt;
        linked.error = error;
        linked.updatedAt = isoNow();
        for (const attempt of linked.attempts.filter((item) => item.codexTurnId === turnId)) {
          attempt.status = "failed";
          attempt.completedAt = completedAt;
          attempt.error = error;
        }
      }
    }
    bundle.prompts.revision += 1;
    bundle.prompts.updatedAt = isoNow();
    bundle.answers.revision += answer ? 1 : 0;
    bundle.answers.updatedAt = isoNow();
    await storage.writeAnswers(tabId, bundle.answers);
    await storage.writePrompts(tabId, bundle.prompts);
    return { prompt, answer };
  });
}

export type HistoryReport = { imported: number; skipped: number; ignored: number; repaired: number };

export type SyncHistoryOptions = {
  /**
   * `authoritative` mirrors a complete provider history. `merge` is used by
   * migrations and partial recovery reads: it may add/repair evidence but must
   * never delete a local record merely because this parse did not see it.
   */
  mode?: "authoritative" | "merge";
};

export async function syncHistory(storage: StorageService, tabId: string, thread: any, options: SyncHistoryOptions = {}): Promise<HistoryReport> {
  const threadId = String(thread?.id ?? thread?.threadId ?? "");
  if (!threadId) throw new Error("THREAD_ID_MISSING");
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const report: HistoryReport = { imported: 0, skipped: 0, ignored: 0, repaired: 0 };
  await storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    const seenPromptIds = new Set<string>();
    const deduplicatedPrompts = bundle.prompts.prompts.filter((prompt) => {
      if (seenPromptIds.has(prompt.id)) return false;
      seenPromptIds.add(prompt.id);
      return true;
    });
    let promptChanges = bundle.prompts.prompts.length - deduplicatedPrompts.length;
    let answerChanges = 0;
    const historyPrompts: PromptRecord[] = [];
    const recordedAnswerTurnIds = new Set<string>();
    bundle.prompts.prompts = deduplicatedPrompts;

    // Prompt files created before thread ownership was recorded can be repaired
    // from their answer linkage. This lets a later sync remove records belonging
    // to a different Codex conversation without deleting unbound queue entries.
    const answerThreadsByPrompt = new Map<string, Set<string>>();
    for (const answer of bundle.answers.answers) {
      const owners = answerThreadsByPrompt.get(answer.promptId) ?? new Set<string>();
      owners.add(answer.threadId);
      answerThreadsByPrompt.set(answer.promptId, owners);
    }
    for (const prompt of bundle.prompts.prompts) {
      const owners = answerThreadsByPrompt.get(prompt.id);
      if (!prompt.threadId && owners?.size === 1) {
        prompt.threadId = [...owners][0];
        prompt.updatedAt = isoNow();
        promptChanges += 1;
      }
    }

    for (const turn of turns) {
      const items = Array.isArray(turn?.items) ? turn.items : [];
      const turnId = String(turn.id ?? turn.turnId ?? "");
      if (!turnId) { report.ignored += 1; continue; }
      const clientId = findClientUserMessageId(items);
      const linkedTurnPrompts = bundle.prompts.prompts.filter((item) => item.codexTurnId === turnId && (!item.threadId || item.threadId === threadId));
      if (!turnCompleted(turn)) {
        const terminalStatus = terminalFailureStatus(turn);
        if (!terminalStatus) {
          const runningAnswer = bundle.answers.answers.find((answer) => answer.threadId === threadId && answer.codexTurnId === turnId && answer.status === "running");
          if (runningAnswer && linkedTurnPrompts.some((prompt) => prompt.status === "running" || prompt.status === "dispatching")) recordedAnswerTurnIds.add(turnId);
          report.ignored += 1;
          continue;
        }
        const prompt = linkedTurnPrompts.find((item) => !promptWasSteeredIntoTurn(item, turnId))
          ?? linkedTurnPrompts[0]
          ?? (clientId ? bundle.prompts.prompts.find((item) => item.clientUserMessageId === clientId && (!item.threadId || item.threadId === threadId)) : undefined);
        // Do not import arbitrary incomplete manual history. A local queue record
        // must already identify the interrupted/failed turn.
        if (!prompt) { report.ignored += 1; continue; }
        const input = extractUserInput(items);
        // An interrupted/failed turn can still carry a partial agent message
        // (e.g. Claude's last text before a missing end_turn). Keep it so the
        // UI can show what was generated instead of an empty answer card.
        const partial = extractFinalAnswer(items);
        const existingAnswer = bundle.answers.answers.find((answer) => answer.threadId === threadId && answer.codexTurnId === turnId);
        const completedAt = protocolTime(turn.completedAt) ?? prompt.completedAt ?? existingAnswer?.completedAt ?? isoNow();
        const error = terminalStatus === "interrupted"
          ? { code: "TURN_INTERRUPTED", message: "Agent turn was interrupted before a final answer was produced." }
          : { code: "TURN_FAILED", message: "Agent turn failed before a final answer was produced." };
        let promptChanged = false;
        const setPrompt = <K extends keyof PromptRecord>(key: K, value: PromptRecord[K]) => {
          if (JSON.stringify(prompt[key]) === JSON.stringify(value)) return;
          prompt[key] = value;
          promptChanged = true;
        };
        setPrompt("threadId", threadId);
        setPrompt("codexTurnId", turnId);
        if (clientId) setPrompt("clientUserMessageId", clientId);
        if (input?.snapshot) setPrompt("inputSnapshot", input.snapshot);
        if (!prompt.text && input?.text) setPrompt("text", input.text);
        setPrompt("startedAt", protocolTime(turn.startedAt) ?? prompt.startedAt);
        setPrompt("completedAt", completedAt);
        setPrompt("status", terminalStatus);
        setPrompt("error", error);
        for (const attempt of prompt.attempts) {
          const matchesTurn = attempt.codexTurnId === turnId;
          const matchesClient = Boolean(clientId) && attempt.clientUserMessageId === clientId;
          if (!matchesTurn && !matchesClient) continue;
          if (attempt.status !== terminalStatus || attempt.completedAt !== completedAt || attempt.codexTurnId !== turnId || JSON.stringify(attempt.error) !== JSON.stringify(error)) {
            attempt.status = terminalStatus;
            attempt.completedAt = completedAt;
            attempt.codexTurnId = turnId;
            attempt.error = error;
            promptChanged = true;
          }
        }
        if (promptChanged) {
          prompt.updatedAt = isoNow();
          promptChanges += 1;
          report.repaired += 1;
        } else {
          report.skipped += 1;
        }
        historyPrompts.push(prompt);
        for (const linked of linkedTurnPrompts.filter((item) => item.id !== prompt.id)) {
          let linkedChanged = false;
          const setLinked = <K extends keyof PromptRecord>(key: K, value: PromptRecord[K]) => {
            if (JSON.stringify(linked[key]) === JSON.stringify(value)) return;
            linked[key] = value;
            linkedChanged = true;
          };
          setLinked("threadId", threadId);
          setLinked("status", terminalStatus);
          setLinked("completedAt", completedAt);
          setLinked("error", error);
          for (const attempt of linked.attempts.filter((item) => item.codexTurnId === turnId)) {
            if (attempt.status === terminalStatus && attempt.completedAt === completedAt && JSON.stringify(attempt.error) === JSON.stringify(error)) continue;
            attempt.status = terminalStatus;
            attempt.completedAt = completedAt;
            attempt.error = error;
            linkedChanged = true;
          }
          if (linkedChanged) { linked.updatedAt = isoNow(); promptChanges += 1; report.repaired += 1; }
          historyPrompts.push(linked);
        }
        const answerPrompts = [prompt, ...linkedTurnPrompts.filter((item) => item.id !== prompt.id)];
        const answerPatch: Partial<AnswerRecord> = {
          promptId: prompt.id,
          origin: prompt.origin,
          prompt: combinedTurnPromptText(input?.text, answerPrompts),
          status: terminalStatus,
          finalAnswer: partial?.text ?? "",
          captureMode: partial?.captureMode ?? null,
          startedAt: protocolTime(turn.startedAt) ?? prompt.startedAt,
          completedAt,
          clientUserMessageId: clientId ?? prompt.clientUserMessageId,
          error,
          metadata: buildAnswerMetadata(answerPrompts, turnId),
        };
        if (!existingAnswer) {
          bundle.answers.answers.push({
            id: randomUUID(),
            promptId: prompt.id,
            threadId,
            codexTurnId: turnId,
            origin: prompt.origin,
            prompt: answerPatch.prompt ?? prompt.text,
            status: terminalStatus,
            finalAnswer: answerPatch.finalAnswer ?? "",
            captureMode: answerPatch.captureMode ?? null,
            startedAt: answerPatch.startedAt ?? null,
            completedAt,
            recordedAt: isoNow(),
            clientUserMessageId: answerPatch.clientUserMessageId ?? null,
            error,
            metadata: answerPatch.metadata ?? {},
          });
          answerChanges += 1;
        } else if (applyAnswerPatch(existingAnswer, answerPatch)) {
          answerChanges += 1;
        }
        recordedAnswerTurnIds.add(turnId);
        continue;
      }
      const input = extractUserInput(items);
      const final = extractFinalAnswer(items);
      if (!input || !final) { report.ignored += 1; continue; }
      recordedAnswerTurnIds.add(turnId);
      const recovery = recoverableSubmissionForTurn(bundle.prompts.prompts, threadId, turn, input.text);
      const supersededPromptIds = new Set(recovery ? linkedTurnPrompts
        .filter((candidate) => (candidate.origin === "manual" || candidate.origin === "imported")
          && candidate.attempts.length === 0
          && sameSubmittedPrompt(candidate.text, input.text))
        .map((candidate) => candidate.id) : []);
      if (supersededPromptIds.size) {
        bundle.prompts.prompts = bundle.prompts.prompts.filter((candidate) => !supersededPromptIds.has(candidate.id));
        promptChanges += supersededPromptIds.size;
      }
      if (recovery?.previousTurnId && recovery.previousTurnId !== turnId) {
        const before = bundle.answers.answers.length;
        bundle.answers.answers = bundle.answers.answers.filter((answer) => !(answer.promptId === recovery.prompt.id
          && answer.codexTurnId === recovery.previousTurnId));
        answerChanges += before - bundle.answers.answers.length;
      }
      const effectiveLinkedTurnPrompts = linkedTurnPrompts.filter((candidate) => !supersededPromptIds.has(candidate.id));
      const existingAnswer = bundle.answers.answers.find((answer) => answer.threadId === threadId && answer.codexTurnId === turnId);
      const existingPrompt = effectiveLinkedTurnPrompts.find((prompt) => !promptWasSteeredIntoTurn(prompt, turnId));
      // Historic turns commonly have no client id. Never compare a missing id:
      // doing so reused the first null-id prompt for every turn and then pushed
      // that same object into the list repeatedly.
      const promptByClientId = clientId
        ? bundle.prompts.prompts.find((item) => item.clientUserMessageId === clientId && (!item.threadId || item.threadId === threadId))
        : undefined;
      const prompt = recovery?.prompt ?? existingPrompt ?? promptByClientId ?? newPrompt(input.text, "imported");
      const createdPrompt = !recovery && !existingPrompt && !promptByClientId;
      let promptChanged = createdPrompt;
      const setPrompt = <K extends keyof PromptRecord>(key: K, value: PromptRecord[K]) => {
        if (JSON.stringify(prompt[key]) === JSON.stringify(value)) return;
        prompt[key] = value;
        promptChanged = true;
      };
      if (createdPrompt || prompt.origin === "imported") setPrompt("origin", "imported");
      if (createdPrompt || prompt.origin === "imported") setPrompt("text", input.text);
      setPrompt("threadId", threadId);
      setPrompt("inputSnapshot", input.snapshot);
      setPrompt("codexTurnId", turnId);
      if (clientId) setPrompt("clientUserMessageId", clientId);
      setPrompt("startedAt", protocolTime(turn.startedAt));
      const turnCompletedAt = protocolTime(turn.completedAt);
      setPrompt("completedAt", turnCompletedAt);
      setPrompt("status", "completed");
      setPrompt("error", null);
      for (const attempt of prompt.attempts) {
        const matchesTurn = attempt.codexTurnId === turnId;
        const matchesClient = Boolean(clientId) && attempt.clientUserMessageId === clientId;
        const matchesRecovery = recovery?.attempt.attemptId === attempt.attemptId;
        if (!matchesTurn && !matchesClient && !matchesRecovery) continue;
        const completedAt = turnCompletedAt ?? attempt.completedAt ?? isoNow();
        if (attempt.status !== "completed" || attempt.completedAt !== completedAt || attempt.codexTurnId !== turnId || attempt.error !== null) {
          attempt.status = "completed";
          attempt.completedAt = completedAt;
          attempt.codexTurnId = turnId;
          attempt.error = null;
          promptChanged = true;
        }
      }
      if (promptChanged) {
        prompt.updatedAt = isoNow();
        promptChanges += 1;
      }
      if (createdPrompt) bundle.prompts.prompts.push(prompt);
      historyPrompts.push(prompt);
      for (const linked of effectiveLinkedTurnPrompts.filter((item) => item.id !== prompt.id)) {
        let linkedChanged = false;
        const setLinked = <K extends keyof PromptRecord>(key: K, value: PromptRecord[K]) => {
          if (JSON.stringify(linked[key]) === JSON.stringify(value)) return;
          linked[key] = value;
          linkedChanged = true;
        };
        setLinked("threadId", threadId);
        setLinked("status", "completed");
        setLinked("completedAt", turnCompletedAt);
        setLinked("error", null);
        for (const attempt of linked.attempts.filter((item) => item.codexTurnId === turnId)) {
          const completedAt = turnCompletedAt ?? attempt.completedAt ?? isoNow();
          if (attempt.status === "completed" && attempt.completedAt === completedAt && attempt.error === null) continue;
          attempt.status = "completed";
          attempt.completedAt = completedAt;
          attempt.error = null;
          linkedChanged = true;
        }
        if (linkedChanged) { linked.updatedAt = isoNow(); promptChanges += 1; report.repaired += 1; }
        historyPrompts.push(linked);
      }

      let repairedAnswer = false;
      const answerPrompts = [prompt, ...effectiveLinkedTurnPrompts.filter((item) => item.id !== prompt.id)];
      const answerPrompt = combinedTurnPromptText(input.text, answerPrompts);
      const answerMetadata = {
        promptIds: answerPrompts.map((item) => item.id),
        steeredPromptIds: effectiveLinkedTurnPrompts.filter((item) => promptWasSteeredIntoTurn(item, turnId)).map((item) => item.id),
      };
      if (!existingAnswer) {
        bundle.answers.answers.push({
          id: randomUUID(),
          promptId: prompt.id,
          threadId,
          codexTurnId: turnId,
          origin: prompt.origin === "queue" || prompt.origin === "timer" ? prompt.origin : "imported",
          prompt: answerPrompt,
          status: "completed",
          finalAnswer: final.text,
          captureMode: final.captureMode,
          startedAt: protocolTime(turn.startedAt),
          completedAt: protocolTime(turn.completedAt),
          recordedAt: isoNow(),
          clientUserMessageId: clientId ?? prompt.clientUserMessageId,
          error: null,
          metadata: answerMetadata,
        });
        answerChanges += 1;
        report.imported += 1;
      } else {
        const answerPatch: Partial<AnswerRecord> = {
          promptId: prompt.id,
          ...(prompt.origin === "queue" || prompt.origin === "timer" ? { origin: prompt.origin } : {}),
          prompt: answerPrompt,
          status: "completed",
          finalAnswer: final.text,
          captureMode: final.captureMode,
          startedAt: protocolTime(turn.startedAt),
          completedAt: protocolTime(turn.completedAt),
          clientUserMessageId: clientId ?? prompt.clientUserMessageId,
          error: null,
          metadata: answerMetadata,
        };
        for (const [key, value] of Object.entries(answerPatch) as Array<[keyof AnswerRecord, AnswerRecord[keyof AnswerRecord]]>) {
          if (JSON.stringify(existingAnswer[key]) === JSON.stringify(value)) continue;
          (existingAnswer as any)[key] = value;
          repairedAnswer = true;
        }
        if (repairedAnswer) answerChanges += 1;
        if (promptChanged || repairedAnswer) report.repaired += 1;
        else report.skipped += 1;
      }
    }
    // final_answers.json mirrors the active conversation. Old-thread answers are
    // reproducible from Codex and must not leak into the currently selected tab.
    if (options.mode !== "merge") {
      const seenAnswerTurns = new Set<string>();
      const syncedAnswers = bundle.answers.answers.filter((answer) => {
        const linkedLifecyclePrompt = bundle.prompts.prompts.find((prompt) => prompt.threadId === threadId
          && prompt.codexTurnId === answer.codexTurnId
          && prompt.status === answer.status);
        const keepLocalLifecycle = answer.status !== "completed" && Boolean(linkedLifecyclePrompt);
        const keep = answer.threadId === threadId
          && (recordedAnswerTurnIds.has(answer.codexTurnId) || keepLocalLifecycle)
          && !seenAnswerTurns.has(answer.codexTurnId);
        if (keep) seenAnswerTurns.add(answer.codexTurnId);
        else answerChanges += 1;
        return keep;
      });
      bundle.answers.answers = syncedAnswers;
    }

    // The Codex history is authoritative and stays first. Keep this thread's
    // local non-history state, then append unbound/current pending prompts in
    // their existing order so closing and reopening cannot jump the queue.
    const historyPromptIds = new Set(historyPrompts.map((prompt) => prompt.id));
    const remainder = bundle.prompts.prompts.filter((prompt) => !historyPromptIds.has(prompt.id));
    // Imported history is reproducible from the provider transcript. If a
    // newer parser no longer recognizes an imported turn (for example a
    // Claude system task notification that was previously mistaken for a
    // human prompt), remove that stale record on the next sync. Keep locally
    // recorded queue/manual completions because the provider transcript can
    // lag briefly behind the durable local lifecycle record.
    const orderedPrompts = options.mode === "merge"
      ? [...historyPrompts, ...remainder]
      : [
        ...historyPrompts,
        ...remainder.filter((prompt) => prompt.threadId === threadId && prompt.status === "completed" && prompt.origin !== "imported"),
        ...remainder.filter((prompt) => prompt.threadId === threadId && prompt.status !== "completed" && prompt.status !== "pending"),
        ...remainder.filter((prompt) => prompt.status === "pending" && (!prompt.threadId || prompt.threadId === threadId)),
      ];
    if (orderedPrompts.length !== bundle.prompts.prompts.length
      || orderedPrompts.some((prompt, index) => bundle.prompts.prompts[index]?.id !== prompt.id)) {
      bundle.prompts.prompts = orderedPrompts;
      promptChanges += 1;
    }
    if (promptChanges) {
      bundle.prompts.revision += 1;
      bundle.prompts.updatedAt = isoNow();
      await storage.writePrompts(tabId, bundle.prompts);
    }
    if (answerChanges) {
      bundle.answers.revision += 1;
      bundle.answers.updatedAt = isoNow();
      await storage.writeAnswers(tabId, bundle.answers);
    }
  });
  return report;
}

function findClientUserMessageId(items: any[]): string | null {
  const user = items.find((item) => ["usermessage", "userinput"].includes(normalizeType(item?.type)) && (item?.clientId || item?.clientUserMessageId));
  return user ? String(user.clientId ?? user.clientUserMessageId) : null;
}

export function historyThreadFromResponse(response: any): any {
  return response?.thread ?? response?.data?.thread ?? response?.data ?? response;
}
