import type { RuntimeFile } from "./schemas.js";

/**
 * What changed in a tab's runtime, rather than the whole runtime again.
 *
 * The file is four fixed sections and every change to any of them was
 * broadcast as the entire object: measured at 580 bytes a time across 5,497
 * messages, while the change that caused it was usually one field of one
 * section moving. Prompts, answers and the navigation index had all been
 * converted to deltas already; this was the last channel still sending its
 * whole document.
 *
 * There are no id-bearing records here, so the record delta the queue uses
 * does not apply. Sections are the natural unit: they are few, they change
 * independently, and a receiver either has the previous revision or does not.
 */
export type RuntimeDelta = {
  /** The revision the receiver must already be holding; otherwise this cannot be applied. */
  from: number;
  revision: number;
  runner?: RuntimeFile["runner"];
  terminal?: RuntimeFile["terminal"];
  reconciliation?: RuntimeFile["reconciliation"];
  queueConfig?: RuntimeFile["queueConfig"];
};

const SECTIONS = ["runner", "terminal", "reconciliation", "queueConfig"] as const;

export function buildRuntimeDelta(previous: RuntimeFile, next: RuntimeFile): RuntimeDelta {
  const delta: RuntimeDelta = { from: previous.revision, revision: next.revision };
  for (const section of SECTIONS) {
    if (JSON.stringify(previous[section]) !== JSON.stringify(next[section])) {
      (delta as Record<string, unknown>)[section] = next[section];
    }
  }
  return delta;
}

/**
 * Null when the receiver is not holding `from`. Applying a delta against a
 * revision it never saw would leave the two sides quietly disagreeing, so the
 * caller asks for the whole runtime instead.
 */
export function applyRuntimeDelta(current: RuntimeFile, delta: RuntimeDelta): RuntimeFile | null {
  if (!delta || typeof delta !== "object") return null;
  if (!Number.isFinite(delta.from) || current.revision !== delta.from) return null;
  return {
    ...current,
    revision: delta.revision,
    runner: delta.runner ?? current.runner,
    terminal: delta.terminal ?? current.terminal,
    reconciliation: delta.reconciliation ?? current.reconciliation,
    queueConfig: delta.queueConfig ?? current.queueConfig,
  };
}

/** Whether a delta carries no section, which happens when a write changed nothing viewers hold. */
export function runtimeDeltaIsEmpty(delta: RuntimeDelta): boolean {
  return SECTIONS.every((section) => delta[section] === undefined);
}
