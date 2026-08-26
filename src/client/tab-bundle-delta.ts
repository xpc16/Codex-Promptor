import type { AnswerRecord, RuntimeFile, TabBundle, TabMeta } from "../shared/schemas.js";
import { applyRecordDelta, type AnswerDelta, type PromptDelta } from "../shared/tab-delta.js";

export type TabMessageResult = { bundle: TabBundle; changed: boolean; needsSnapshot: boolean };

export function applyTabMessage(bundle: TabBundle, message: any): TabMessageResult {
  if (message?.type === "snapshot" && message.data) return { bundle: message.data as TabBundle, changed: true, needsSnapshot: false };
  if (message?.type === "tab.changed" && message.tab) {
    return { bundle: { ...bundle, tab: message.tab as TabMeta }, changed: true, needsSnapshot: false };
  }
  if ((message?.type === "runner.changed" || message?.type === "runtime.changed") && message.runner) {
    const runtime = message.runner as RuntimeFile;
    if (runtime.revision <= bundle.runtime.revision) return unchanged(bundle);
    if (runtime.revision > bundle.runtime.revision + 1) return missing(bundle);
    return { bundle: { ...bundle, runtime }, changed: true, needsSnapshot: false };
  }
  if (message?.type === "prompts.changed" && message.delta) {
    const delta = message.delta as PromptDelta;
    if (delta.revision <= bundle.prompts.revision) return unchanged(bundle);
    if (delta.revision > bundle.prompts.revision + 1) return missing(bundle);
    const prompts = applyRecordDelta(bundle.prompts.prompts, delta);
    let completed = bundle.window?.prompts.completed ?? prompts.filter((prompt) => prompt.status === "completed").length;
    if (bundle.window && delta.completed === undefined) {
      const before = new Map(bundle.prompts.prompts.map((prompt) => [prompt.id, prompt.status]));
      for (const prompt of delta.upserts) {
        const oldCompleted = before.get(prompt.id) === "completed";
        const newCompleted = prompt.status === "completed";
        if (oldCompleted !== newCompleted) completed += newCompleted ? 1 : -1;
      }
      for (const id of delta.deletedIds) if (before.get(id) === "completed") completed -= 1;
    } else if (delta.completed !== undefined) completed = delta.completed;
    return {
      bundle: {
        ...bundle,
        prompts: { ...bundle.prompts, revision: delta.revision, updatedAt: delta.updatedAt, prompts },
        ...(bundle.window ? { window: { ...bundle.window, prompts: { start: Math.min(bundle.window.prompts.start, Math.max(0, delta.total - prompts.length)), total: delta.total, completed: Math.max(0, completed) } } } : {}),
      },
      changed: true,
      needsSnapshot: false,
    };
  }
  if (message?.type === "answers.changed" && message.delta) {
    const delta = message.delta as AnswerDelta;
    if (delta.revision <= bundle.answers.revision) return unchanged(bundle);
    if (delta.revision > bundle.answers.revision + 1) return missing(bundle);
    const answers = applyRecordDelta(bundle.answers.answers, delta);
    return {
      bundle: {
        ...bundle,
        answers: { ...bundle.answers, revision: delta.revision, updatedAt: delta.updatedAt, answers },
        ...(bundle.window ? { window: { ...bundle.window, answers: { start: Math.min(bundle.window.answers.start, Math.max(0, delta.total - answers.length)), total: delta.total } } } : {}),
      },
      changed: true,
      needsSnapshot: false,
    };
  }
  // Backward-compatible server event during rolling upgrades.
  if ((message?.type === "answer.added" || message?.type === "answer.changed") && message.answer) {
    const answer = message.answer as AnswerRecord;
    const answers = [...bundle.answers.answers];
    const index = answers.findIndex((item) => item.id === answer.id);
    if (index < 0) answers.push(answer); else answers[index] = answer;
    return { bundle: { ...bundle, answers: { ...bundle.answers, answers } }, changed: true, needsSnapshot: false };
  }
  return unchanged(bundle);
}

function unchanged(bundle: TabBundle): TabMessageResult { return { bundle, changed: false, needsSnapshot: false }; }
function missing(bundle: TabBundle): TabMessageResult { return { bundle, changed: false, needsSnapshot: true }; }
