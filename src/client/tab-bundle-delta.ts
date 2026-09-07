import type { AnswerRecord, RuntimeFile, TabBundle, TabMeta } from "../shared/schemas.js";
import { applyRuntimeDelta, type RuntimeDelta } from "../shared/runtime-delta.js";
import { applyRecordDelta, moveIsApplicable, type AnswerDelta, type PromptDelta } from "../shared/tab-delta.js";

export type TabMessageResult = { bundle: TabBundle; changed: boolean; needsSnapshot: boolean };

type WindowSpan = { start: number; total: number };

/**
 * Older records the reader has already scrolled open, kept across a snapshot.
 *
 * A snapshot carries the opening window only. Letting it replace the list
 * outright would throw away history this browser already paid to download and
 * send the reader back through the same scroll-back requests. The two lists
 * are spliced only when they demonstrably belong to the same history: the
 * snapshot's first record must appear in the current list, and the records
 * ahead of it must be exactly the gap between the two window starts. Anything
 * else -- a resumed thread, a cleared conversation -- fails that check and the
 * snapshot wins whole, which is what a changed thread needs.
 */
export function retainEarlierRecords<T extends { id: string }>(
  current: readonly T[],
  currentSpan: WindowSpan | undefined,
  next: readonly T[],
  nextSpan: WindowSpan | undefined,
): T[] | null {
  if (!currentSpan || !nextSpan || next.length === 0) return null;
  if (currentSpan.start >= nextSpan.start) return null;
  const overlap = current.findIndex((record) => record.id === next[0].id);
  if (overlap < 0 || overlap !== nextSpan.start - currentSpan.start) return null;
  return [...current.slice(0, overlap), ...next];
}

export function applyTabMessage(bundle: TabBundle, message: any): TabMessageResult {
  if (message?.type === "snapshot" && message.data) return { bundle: mergeSnapshot(bundle, message.data as TabBundle), changed: true, needsSnapshot: false };
  if (message?.type === "tab.changed" && message.tab) {
    return { bundle: { ...bundle, tab: message.tab as TabMeta }, changed: true, needsSnapshot: false };
  }
  if ((message?.type === "runner.changed" || message?.type === "runtime.changed") && message.runner) {
    const runtime = message.runner as RuntimeFile;
    if (runtime.revision <= bundle.runtime.revision) return unchanged(bundle);
    if (runtime.revision > bundle.runtime.revision + 1) return missing(bundle);
    return { bundle: { ...bundle, runtime }, changed: true, needsSnapshot: false };
  }
  if ((message?.type === "runner.changed" || message?.type === "runtime.changed") && message.delta) {
    const delta = message.delta as RuntimeDelta;
    if (delta.revision <= bundle.runtime.revision) return unchanged(bundle);
    // A delta that does not line up with what this bundle holds cannot be
    // applied halfway; a snapshot is the path a missed revision already takes.
    const runtime = applyRuntimeDelta(bundle.runtime, delta);
    if (!runtime) return missing(bundle);
    return { bundle: { ...bundle, runtime }, changed: true, needsSnapshot: false };
  }
  if (message?.type === "prompts.changed" && message.delta) {
    const delta = message.delta as PromptDelta;
    if (delta.revision <= bundle.prompts.revision) return unchanged(bundle);
    if (delta.revision > bundle.prompts.revision + 1) return missing(bundle);
    // A move whose anchor row is not loaded here cannot be placed by guessing.
    if (!moveIsApplicable(bundle.prompts.prompts, delta.move)) return missing(bundle);
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

function mergeSnapshot(current: TabBundle, next: TabBundle): TabBundle {
  if (current.tab.id !== next.tab.id) return next;
  const prompts = retainEarlierRecords(current.prompts.prompts, current.window?.prompts, next.prompts.prompts, next.window?.prompts);
  const answers = retainEarlierRecords(current.answers.answers, current.window?.answers, next.answers.answers, next.window?.answers);
  if (!prompts && !answers) return next;
  return {
    ...next,
    ...(prompts ? { prompts: { ...next.prompts, prompts } } : {}),
    ...(answers ? { answers: { ...next.answers, answers } } : {}),
    ...(next.window ? {
      window: {
        prompts: prompts ? { ...next.window.prompts, start: current.window!.prompts.start } : next.window.prompts,
        answers: answers ? { ...next.window.answers, start: current.window!.answers.start } : next.window.answers,
      },
    } : {}),
  };
}

function unchanged(bundle: TabBundle): TabMessageResult { return { bundle, changed: false, needsSnapshot: false }; }
function missing(bundle: TabBundle): TabMessageResult { return { bundle, changed: false, needsSnapshot: true }; }
