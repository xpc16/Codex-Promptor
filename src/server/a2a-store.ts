import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { A2A_ROOT_STATUSES, A2aLimitsSchema, DEFAULT_A2A_LIMITS } from "../shared/a2a.js";
import { isoNow } from "../shared/schemas.js";
import { A2aPolicySchema } from "./a2a-policy.js";
import { writeFileAtomicWithRetry, type StorageService } from "./storage.js";

/**
 * One small file per collaboration root, under `data/a2a/`.
 *
 * No database and no message bus: the messages themselves are already queue
 * prompts in the participants' own files. What is not derivable from those --
 * who joined, how much of the budget is gone, whether the root has been
 * declared finished -- lives here, and has to survive a restart, because a
 * collaboration outlives any one process (docs/AGENT_TO_AGENT.md 5.3).
 */

const MemberSchema = z.object({
  tabId: z.string(),
  threadId: z.string().nullable().default(null),
  role: z.string(),
  level: z.number().int().nonnegative(),
  parentTabId: z.string().nullable().default(null),
  joinedAt: z.string(),
});
export type A2aMember = z.infer<typeof MemberSchema>;

const ReceiptSchema = z.object({
  /** `(source tab, contextId, requestId)`, hashed. */
  key: z.string(),
  op: z.string(),
  /** Hash of the request parameters: the same key with different parameters is a conflict, not a replay. */
  digest: z.string(),
  resultId: z.string().nullable().default(null),
  result: z.record(z.string(), z.unknown()).default({}),
  at: z.string(),
});
export type A2aReceipt = z.infer<typeof ReceiptSchema>;

const PendingFinishSchema = z.object({
  intent: z.enum(["complete", "stop"]),
  reason: z.string(),
  requestedBy: z.string().nullable().default(null),
  attemptId: z.string().nullable().default(null),
  requestId: z.string().nullable().default(null),
  requestedAt: z.string(),
});

export const A2aRootSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  rootId: z.string(),
  revision: z.number().int().nonnegative().default(0),
  status: z.enum(A2A_ROOT_STATUSES),
  skill: z.string(),
  skillVersion: z.string(),
  /** Frozen at start: editing the file on disk cannot change a running collaboration. */
  skillBody: z.string(),
  policy: A2aPolicySchema,
  permissionMode: z.enum(["soft", "hard"]).default("soft"),
  originTabId: z.string(),
  originPromptId: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  endedAt: z.string().nullable().default(null),
  endReason: z.string().nullable().default(null),
  limits: A2aLimitsSchema.default(DEFAULT_A2A_LIMITS),
  usedMessages: z.number().int().nonnegative().default(0),
  usedSpawns: z.number().int().nonnegative().default(0),
  members: z.array(MemberSchema).default([]),
  pendingFinish: PendingFinishSchema.nullable().default(null),
  receipts: z.array(ReceiptSchema).default([]),
});
export type A2aRoot = z.infer<typeof A2aRootSchema>;

const MAX_RECEIPTS = 200;

export function receiptKey(fromTabId: string, contextId: string, requestId: string): string {
  return createHash("sha1").update(`${fromTabId} ${contextId} ${requestId}`).digest("hex").slice(0, 16);
}

export function paramsDigest(params: unknown): string {
  return createHash("sha1").update(JSON.stringify(params ?? null)).digest("hex").slice(0, 16);
}

export class A2aStore {
  readonly dir: string;
  /** Roots seen this process, so the purple light does not re-read the directory on every tab read. */
  private readonly cache = new Map<string, A2aRoot>();
  private listed = false;

  constructor(private readonly storage: StorageService) {
    this.dir = path.join(storage.dataDir, "a2a");
  }

  private file(rootId: string): string {
    // Root ids are prompt ids the server generated; refuse anything that could leave the directory.
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(rootId)) throw new Error("A2A_ROOT_ID_INVALID");
    return path.join(this.dir, `${rootId}.json`);
  }

  /** Serialised on the same mutex as tab writes, so lock order is one order everywhere. */
  async withRootLock<T>(rootId: string, task: () => Promise<T>): Promise<T> {
    return this.storage.withA2aRootLock(rootId, task);
  }

  async read(rootId: string): Promise<A2aRoot | null> {
    const cached = this.cache.get(rootId);
    if (cached) return cached;
    try {
      const parsed = A2aRootSchema.parse(JSON.parse(await fs.readFile(this.file(rootId), "utf8")));
      this.cache.set(rootId, parsed);
      return parsed;
    } catch { return null; }
  }

  async write(root: A2aRoot): Promise<A2aRoot> {
    const value = A2aRootSchema.parse({ ...root, revision: root.revision + 1 });
    await fs.mkdir(this.dir, { recursive: true });
    await writeFileAtomicWithRetry(this.file(value.rootId), JSON.stringify(value, null, 2));
    this.cache.set(value.rootId, value);
    return value;
  }

  /** Every root on disk. Read once per process and then kept current by `write`. */
  async all(): Promise<A2aRoot[]> {
    if (!this.listed) {
      let names: string[] = [];
      try { names = await fs.readdir(this.dir); } catch { names = []; }
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        await this.read(name.slice(0, -5));
      }
      this.listed = true;
    }
    return [...this.cache.values()];
  }

  /**
   * A free root id for a prompt whose previous collaboration has ended.
   *
   * Root ids are prompt ids, so re-running the same prompt cannot reuse one
   * without overwriting the record of what happened last time -- and a root
   * that a person explicitly stopped is exactly the record worth keeping.
   */
  async nextRootId(promptId: string): Promise<string> {
    const taken = new Set((await this.all()).map((root) => root.rootId));
    for (let attempt = 2; attempt < 1000; attempt += 1) {
      const candidate = `${promptId}-${attempt}`;
      if (!taken.has(candidate)) return candidate;
    }
    throw new Error("A2A_ROOT_ID_EXHAUSTED");
  }

  /** Roots this conversation has joined, newest first. */
  async forTab(tabId: string): Promise<A2aRoot[]> {
    return (await this.all())
      .filter((root) => root.members.some((member) => member.tabId === tabId))
      .sort((left, right) => (right.startedAt ?? right.createdAt).localeCompare(left.startedAt ?? left.createdAt));
  }

  member(root: A2aRoot, tabId: string): A2aMember | null {
    return root.members.find((member) => member.tabId === tabId) ?? null;
  }

  /**
   * Participants only ever join. A conversation that finished its own piece is
   * still in the collaboration until the whole root ends, which is what keeps
   * its queue light on.
   */
  join(root: A2aRoot, member: Omit<A2aMember, "joinedAt">): A2aRoot {
    if (root.members.some((existing) => existing.tabId === member.tabId)) {
      return {
        ...root,
        members: root.members.map((existing) => existing.tabId === member.tabId && !existing.threadId
          ? { ...existing, threadId: member.threadId }
          : existing),
      };
    }
    return { ...root, members: [...root.members, { ...member, joinedAt: isoNow() }] };
  }

  findReceipt(root: A2aRoot, key: string): A2aReceipt | null {
    return root.receipts.find((receipt) => receipt.key === key) ?? null;
  }

  recordReceipt(root: A2aRoot, receipt: A2aReceipt): A2aRoot {
    const receipts = [...root.receipts.filter((existing) => existing.key !== receipt.key), receipt];
    return { ...root, receipts: receipts.slice(-MAX_RECEIPTS) };
  }
}
