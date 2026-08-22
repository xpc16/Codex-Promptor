import { randomUUID } from "node:crypto";
import { isoNow, type AnswerRecord, type Origin, type PromptRecord, newPrompt, type TabBundle } from "../shared/schemas.js";
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
  const lastAgent = agents.at(-1);
  const fallback = textFromValue(lastAgent?.text ?? lastAgent?.content ?? lastAgent?.message);
  if (fallback) return { text: fallback, captureMode: "fallback_last_agent_message" };
  const plan = items.filter((item) => normalizeType(item?.type) === "plan").at(-1);
  const planText = textFromValue(plan?.text ?? plan?.content ?? plan?.plan);
  return planText ? { text: planText, captureMode: "fallback_plan" } : null;
}

export const turnCompleted = (turn: any): boolean => {
  const status = String(turn?.status ?? "completed").toLowerCase();
  return ["completed", "complete", "succeeded", "success"].includes(status);
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

export type RecordTurnOptions = {
  threadId: string;
  turn: any;
  items: any[];
  origin: Origin;
  promptId?: string | null;
  promptText?: string;
  clientUserMessageId?: string | null;
};

export async function recordTurn(storage: StorageService, tabId: string, options: RecordTurnOptions): Promise<{ prompt: PromptRecord | null; answer: AnswerRecord | null }> {
  const turnId = String(options.turn?.id ?? options.turn?.turnId ?? "");
  if (!turnId) throw new Error("TURN_ID_MISSING");
  const input = extractUserInput(options.items);
  const final = extractFinalAnswer(options.items);
  if (!input && !options.promptText) return { prompt: null, answer: null };
  return storage.withTabLock(tabId, async () => {
    const bundle = await storage.readTab(tabId);
    let prompt = bundle.prompts.prompts.find((item) => item.codexTurnId === turnId)
      ?? (options.promptId ? bundle.prompts.prompts.find((item) => item.id === options.promptId) : undefined)
      ?? (options.clientUserMessageId ? bundle.prompts.prompts.find((item) => item.clientUserMessageId === options.clientUserMessageId) : undefined);
    if (!prompt) {
      prompt = newPrompt(options.promptText ?? input?.text ?? "[无文本输入]", options.origin);
      prompt.inputSnapshot = input?.snapshot;
      bundle.prompts.prompts.push(prompt);
    } else if (!prompt.text && (options.promptText ?? input?.text)) {
      prompt.text = options.promptText ?? input?.text ?? prompt.text;
    }
    prompt.origin = options.origin;
    prompt.codexTurnId = turnId;
    prompt.clientUserMessageId = options.clientUserMessageId ?? prompt.clientUserMessageId;
    prompt.startedAt = protocolTime(options.turn?.startedAt) ?? prompt.startedAt;
    prompt.updatedAt = isoNow();
    if (input?.snapshot && !prompt.inputSnapshot) prompt.inputSnapshot = input.snapshot;

    const completedAt = protocolTime(options.turn?.completedAt) ?? isoNow();
    let answer: AnswerRecord | null = null;
    if (final) {
      answer = bundle.answers.answers.find((item) => item.threadId === options.threadId && item.codexTurnId === turnId) ?? null;
      if (!answer) {
        answer = {
          id: randomUUID(),
          promptId: prompt.id,
          threadId: options.threadId,
          codexTurnId: turnId,
          origin: options.origin,
          prompt: prompt.text,
          finalAnswer: final.text,
          captureMode: final.captureMode,
          startedAt: protocolTime(options.turn?.startedAt) ?? prompt.startedAt,
          completedAt,
          recordedAt: isoNow(),
          clientUserMessageId: options.clientUserMessageId ?? prompt.clientUserMessageId,
          metadata: {},
        };
        bundle.answers.answers.push(answer);
      }
      prompt.status = "completed";
      prompt.completedAt = completedAt;
      prompt.error = null;
      const attempt = prompt.attempts.find((item) => item.codexTurnId === turnId);
      if (attempt) {
        attempt.status = "completed";
        attempt.completedAt = completedAt;
      }
    } else if (options.origin === "queue") {
      prompt.status = "failed";
      prompt.error = { code: "NO_FINAL_ANSWER", message: "Turn completed without a final answer." };
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

export async function syncHistory(storage: StorageService, tabId: string, thread: any): Promise<HistoryReport> {
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
    bundle.prompts.prompts = deduplicatedPrompts;
    for (const turn of turns) {
      if (!turnCompleted(turn)) { report.ignored += 1; continue; }
      const items = Array.isArray(turn?.items) ? turn.items : [];
      const input = extractUserInput(items);
      const final = extractFinalAnswer(items);
      if (!input || !final) { report.ignored += 1; continue; }
      const turnId = String(turn.id ?? turn.turnId ?? "");
      if (!turnId) { report.ignored += 1; continue; }
      const threadId = String(thread.id ?? thread.threadId);
      const existingAnswer = bundle.answers.answers.find((answer) => answer.threadId === threadId && answer.codexTurnId === turnId);
      const existingPrompt = bundle.prompts.prompts.find((prompt) => prompt.codexTurnId === turnId);
      const clientId = findClientUserMessageId(items);
      // Historic turns commonly have no client id. Never compare a missing id:
      // doing so reused the first null-id prompt for every turn and then pushed
      // that same object into the list repeatedly.
      const promptByClientId = clientId
        ? bundle.prompts.prompts.find((item) => item.clientUserMessageId === clientId)
        : undefined;
      const prompt = existingPrompt ?? promptByClientId ?? newPrompt(input.text, "imported");
      const createdPrompt = !existingPrompt && !promptByClientId;
      let promptChanged = createdPrompt;
      const setPrompt = <K extends keyof PromptRecord>(key: K, value: PromptRecord[K]) => {
        if (JSON.stringify(prompt[key]) === JSON.stringify(value)) return;
        prompt[key] = value;
        promptChanged = true;
      };
      if (createdPrompt || prompt.origin === "imported") setPrompt("origin", "imported");
      if (createdPrompt || prompt.origin === "imported") setPrompt("text", input.text);
      setPrompt("inputSnapshot", input.snapshot);
      setPrompt("codexTurnId", turnId);
      if (clientId) setPrompt("clientUserMessageId", clientId);
      setPrompt("startedAt", protocolTime(turn.startedAt));
      setPrompt("completedAt", protocolTime(turn.completedAt));
      setPrompt("status", "completed");
      setPrompt("error", null);
      if (promptChanged) {
        prompt.updatedAt = isoNow();
        promptChanges += 1;
      }
      if (createdPrompt) bundle.prompts.prompts.push(prompt);
      historyPrompts.push(prompt);

      let repairedAnswer = false;
      if (!existingAnswer) {
        bundle.answers.answers.push({
          id: randomUUID(),
          promptId: prompt.id,
          threadId,
          codexTurnId: turnId,
          origin: "imported",
          prompt: prompt.text,
          finalAnswer: final.text,
          captureMode: final.captureMode,
          startedAt: protocolTime(turn.startedAt),
          completedAt: protocolTime(turn.completedAt),
          recordedAt: isoNow(),
          clientUserMessageId: clientId,
          metadata: {},
        });
        answerChanges += 1;
        report.imported += 1;
      } else {
        const answerPatch: Partial<AnswerRecord> = {
          promptId: prompt.id,
          prompt: prompt.text,
          finalAnswer: final.text,
          captureMode: final.captureMode,
          startedAt: protocolTime(turn.startedAt),
          completedAt: protocolTime(turn.completedAt),
          clientUserMessageId: clientId,
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
    const historyPromptIds = new Set(historyPrompts.map((prompt) => prompt.id));
    const orderedPrompts = [
      ...historyPrompts,
      ...bundle.prompts.prompts.filter((prompt) => !historyPromptIds.has(prompt.id)),
    ];
    if (orderedPrompts.some((prompt, index) => bundle.prompts.prompts[index]?.id !== prompt.id)) {
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
