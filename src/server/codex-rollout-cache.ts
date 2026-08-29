import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { readCodexRolloutSlice, type CodexRolloutThread, type CodexRolloutTurn } from "./codex-history.js";

/**
 * Reading a rollout once instead of once per launch.
 *
 * Rollouts are append-only and large -- five open conversations on this machine
 * come to about half a gigabyte -- and every restore parsed all of it from the
 * first byte. What changes between launches is a tail, so the parsed turns are
 * kept beside the tab and only the tail is read.
 *
 * The cache holds parsed turns rather than a sync watermark on purpose.
 * `syncHistory` treats the turn list it is given as the whole truth and deletes
 * records for turns missing from it, so handing it only the new turns would
 * erase the conversation. It is still given the complete list; only the reading
 * is incremental.
 */

/**
 * Bumped whenever the parser could produce different turns for the same bytes.
 * An older cache is discarded rather than merged, because a half-old turn list
 * is exactly what syncHistory would treat as a deletion.
 */
export const ROLLOUT_PARSE_VERSION = 1;

const HEAD_BYTES = 4096;

export type RolloutCache = {
  version: number;
  threadId: string;
  file: string;
  /** Bytes already folded into `turns`; the next read starts here. */
  offset: number;
  /** File size when this was written, so a shorter file means a different file. */
  size: number;
  /** Fingerprint of the opening bytes, so a rewritten rollout is not read at a stale offset. */
  head: string;
  turns: CodexRolloutTurn[];
};

/** A rollout that was rotated or rewritten keeps its path but not its opening bytes. */
export async function readRolloutHead(file: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(file, { start: 0, end: HEAD_BYTES - 1 });
  for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest("hex").slice(0, 32);
}

/**
 * Cached turns updated by the freshly read ones, keeping the order they were
 * first seen in. A turn re-read because it was still running replaces its older
 * shape; a new one is appended.
 */
export function mergeCachedTurns(
  cached: readonly CodexRolloutTurn[],
  fresh: readonly CodexRolloutTurn[],
): CodexRolloutTurn[] {
  const byId = new Map(fresh.map((turn) => [turn.id, turn]));
  const merged = cached.map((turn) => byId.get(turn.id) ?? turn);
  const known = new Set(cached.map((turn) => turn.id));
  return [...merged, ...fresh.filter((turn) => !known.has(turn.id))];
}

async function readCache(cachePath: string): Promise<RolloutCache | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.turns)) return null;
    return parsed as RolloutCache;
  } catch { return null; }
}

/**
 * The complete turns a rollout records, reading only what the cache has not
 * already accounted for. A cache that cannot be trusted is not repaired, it is
 * ignored: the full read is what happens today and is always correct.
 */
export async function readCodexRolloutCached(
  file: string,
  threadId: string,
  cachePath: string,
): Promise<CodexRolloutThread> {
  const [stat, head, cached] = await Promise.all([fs.stat(file), readRolloutHead(file), readCache(cachePath)]);
  const usable = Boolean(cached
    && cached.version === ROLLOUT_PARSE_VERSION
    && cached.threadId === threadId
    && cached.file === file
    && cached.head === head
    && cached.size <= stat.size
    && cached.offset >= 0
    && cached.offset <= stat.size);
  const slice = await readCodexRolloutSlice(file, threadId, usable ? cached!.offset : 0);
  const turns = usable ? mergeCachedTurns(cached!.turns, slice.turns) : slice.turns;
  const next: RolloutCache = {
    version: ROLLOUT_PARSE_VERSION,
    threadId,
    file,
    offset: slice.resumeOffset,
    size: stat.size,
    head,
    turns,
  };
  // A cache that cannot be written costs the next launch a full read; it must
  // never cost this one its history.
  await fs.writeFile(cachePath, JSON.stringify(next), "utf8").catch(() => undefined);
  return { id: threadId, sessionId: threadId, turns };
}
