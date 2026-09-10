import { z } from "zod";

/**
 * Agent to Agent: the shapes both ends agree on.
 *
 * A collaboration is a *root*: one user prompt that began with `@@`, plus
 * every message and conversation that descends from it. The root is what has
 * a lifecycle, a budget and an end; a single prompt finishing is not the end
 * of anything (docs/AGENT_TO_AGENT.md §5.1).
 */

export const A2A_SKILL_NAME_PATTERN = /^[a-z0-9_-]{1,40}$/;
export const DEFAULT_A2A_SKILL = "central";

export const A2aLimitsSchema = z.object({
  messages: z.number().int().positive(),
  depth: z.number().int().positive(),
  spawns: z.number().int().nonnegative(),
  inboundPerMinute: z.number().int().positive(),
});
export type A2aLimits = z.infer<typeof A2aLimitsSchema>;

/**
 * Deliberately small. Every message here is a real model turn on someone's
 * machine, so the default has to be one a reader would not mind discovering
 * after the fact.
 */
export const DEFAULT_A2A_LIMITS: A2aLimits = { messages: 20, depth: 3, spawns: 3, inboundPerMinute: 4 };

/** What a prompt carries when it belongs to a collaboration. The root prompt's source fields are null. */
export const A2aPromptMetaSchema = z.object({
  rootId: z.string(),
  skill: z.string(),
  depth: z.number().int().nonnegative(),
  fromTabId: z.string().nullable().default(null),
  fromPromptId: z.string().nullable().default(null),
});
export type A2aPromptMeta = z.infer<typeof A2aPromptMetaSchema>;

export const A2A_ROOT_STATUSES = ["pending", "running", "ending", "completed", "stopped"] as const;
export type A2aRootStatus = (typeof A2A_ROOT_STATUSES)[number];

export type A2aBudget = {
  revision: number;
  usedMessages: number;
  remainingMessages: number;
  currentDepth: number;
  remainingHops: number;
  remainingSpawns: number;
};

export type A2aAdvice = "continue" | "wrap_up" | "finalize_locally";

export type A2aBudgetSnapshot = {
  limits: A2aLimits;
  budget: A2aBudget;
  advice: A2aAdvice;
};

/**
 * One calculation, used by the dispatch preamble, by `status`, and by every
 * receipt -- so an agent is never told two different numbers for the same
 * moment. `currentDepth` is the depth of the message being executed, not a
 * property of the root.
 */
export function a2aBudget(
  input: { limits: A2aLimits; usedMessages: number; usedSpawns: number; revision: number },
  currentDepth: number,
): A2aBudget {
  return {
    revision: input.revision,
    usedMessages: input.usedMessages,
    remainingMessages: Math.max(0, input.limits.messages - input.usedMessages),
    currentDepth,
    remainingHops: Math.max(0, input.limits.depth - currentDepth),
    remainingSpawns: Math.max(0, input.limits.spawns - input.usedSpawns),
  };
}

/**
 * Advice, not a state. Nothing in the server changes because of it; it exists
 * so an agent converges before the hard limit rather than discovering it with
 * a half-finished delegation tree.
 */
export function a2aAdvice(limits: A2aLimits, budget: A2aBudget): A2aAdvice {
  if (budget.remainingMessages === 0 || budget.remainingHops === 0) return "finalize_locally";
  if (budget.remainingMessages <= Math.ceil(limits.messages * 0.2) || budget.remainingHops <= 1) return "wrap_up";
  return "continue";
}

export function a2aSnapshot(
  input: { limits: A2aLimits; usedMessages: number; usedSpawns: number; revision: number },
  currentDepth: number,
): A2aBudgetSnapshot {
  const budget = a2aBudget(input, currentDepth);
  return { limits: input.limits, budget, advice: a2aAdvice(input.limits, budget) };
}

/** One root as a page sees it: enough to show the light and the counters, and nothing else. */
export type A2aRootSummary = {
  rootId: string;
  skill: string;
  status: A2aRootStatus;
  permissionMode: "soft" | "hard";
  role: string;
  level: number;
  startedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  originTabId: string;
  originTabName: string;
  participants: number;
  limits: A2aLimits;
  usedMessages: number;
  remainingMessages: number;
  usedSpawns: number;
  advice: A2aAdvice;
  /** Set while the root is unfinished but this conversation's session is not. */
  sessionClosed?: boolean;
};

/**
 * The purple light comes from `active`, which is a property of the *root set*,
 * not of the queue: a participant that has finished its own work and is
 * waiting for someone else is still collaborating.
 */
export type A2aTabSummary = { roots: A2aRootSummary[]; active: boolean };

export function a2aTabSummary(roots: A2aRootSummary[]): A2aTabSummary {
  return { roots, active: roots.some((root) => root.status === "running" || root.status === "ending") };
}
