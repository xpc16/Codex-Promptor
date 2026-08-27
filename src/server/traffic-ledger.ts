/**
 * What this service actually sends and receives, aggregated into time buckets.
 *
 * The point is to answer one question later: *which of these bytes did nobody
 * need?* That needs four facts per kind of traffic -- how often, how much, how
 * big the worst one was, and how well it compressed -- collected over days of
 * ordinary use rather than guessed at.
 *
 * This is a message-level ledger, not a packet capture: Node cannot see TCP
 * segments, and the actionable layer is the message anyway. "One
 * `terminal.screen` every 500ms averaging 400 bytes" is something you can act
 * on; a packet count is not.
 *
 * Content is never recorded -- only counts, sizes and a key naming the kind.
 */

export type TrafficDirection = "out" | "in";
export type TrafficChannel = "ws" | "http";

export type TrafficEntry = {
  /** Messages or responses. */
  count: number;
  /** Bytes as they left this process: post-compression for HTTP, pre-deflate for WebSocket. */
  bytes: number;
  /** Bytes before any compression, so the ratio is visible. */
  rawBytes: number;
  /** The single largest one seen, which is how outliers get found. */
  max: number;
};

export type TrafficBucket = {
  /** ISO timestamp of the bucket's start. */
  startedAt: string;
  entries: Record<string, TrafficEntry>;
};

export type TrafficRollup = {
  from: string | null;
  to: string | null;
  seconds: number;
  totals: TrafficEntry;
  entries: Record<string, TrafficEntry & { perMinute: number; bytesPerSecond: number }>;
};

export const DEFAULT_BUCKET_MS = 60_000;
/** Route patterns and message types are a small fixed set; this only guards a bug. */
export const DEFAULT_MAX_KEYS = 250;
/** 24h of one-minute buckets, so a day is always answerable without reading files. */
export const DEFAULT_RETAINED_BUCKETS = 1_440;

export const OVERFLOW_KEY = "other";

export type TrafficLedgerOptions = {
  bucketMs?: number;
  maxKeys?: number;
  retainedBuckets?: number;
};

export type TrafficLedger = {
  record(direction: TrafficDirection, channel: TrafficChannel, type: string, bytes: number, rawBytes?: number, at?: number): void;
  /** Buckets that are complete as of `at`, removed from the pending set so a writer can append them once. */
  drain(at?: number): TrafficBucket[];
  /** The rolling in-memory window, oldest first, including the bucket still filling. */
  buckets(): TrafficBucket[];
  rollup(options?: { sinceMs?: number; at?: number }): TrafficRollup;
  reset(): void;
};

export function trafficKey(direction: TrafficDirection, channel: TrafficChannel, type: string): string {
  const cleaned = String(type).trim().replace(/\s+/g, " ").slice(0, 120) || "unknown";
  return `${direction}:${channel}:${cleaned}`;
}

export function createTrafficLedger(options: TrafficLedgerOptions = {}): TrafficLedger {
  const bucketMs = Math.max(1_000, Math.trunc(options.bucketMs ?? DEFAULT_BUCKET_MS));
  const maxKeys = Math.max(8, Math.trunc(options.maxKeys ?? DEFAULT_MAX_KEYS));
  const retainedBuckets = Math.max(2, Math.trunc(options.retainedBuckets ?? DEFAULT_RETAINED_BUCKETS));

  /** Bucket start (epoch ms) → entries. Ordered by insertion, which is chronological. */
  let open = new Map<number, Map<string, TrafficEntry>>();
  /** Sealed buckets already handed to a writer, kept for the in-memory window. */
  let sealed: TrafficBucket[] = [];

  const bucketStart = (at: number) => Math.floor(at / bucketMs) * bucketMs;

  const entriesFor = (at: number): Map<string, TrafficEntry> => {
    const start = bucketStart(at);
    const existing = open.get(start);
    if (existing) return existing;
    const created = new Map<string, TrafficEntry>();
    open.set(start, created);
    return created;
  };

  const trim = () => {
    while (sealed.length + open.size > retainedBuckets && sealed.length > 0) sealed.shift();
    // A pathological clock jump could fill `open` on its own; never let it grow past the window.
    while (open.size > retainedBuckets) {
      const oldest = open.keys().next();
      if (oldest.done) break;
      open.delete(oldest.value);
    }
  };

  const toBucket = (start: number, entries: Map<string, TrafficEntry>): TrafficBucket => ({
    startedAt: new Date(start).toISOString(),
    entries: Object.fromEntries([...entries.entries()].map(([key, entry]) => [key, { ...entry }])),
  });

  return {
    record(direction, channel, type, bytes, rawBytes, at = Date.now()) {
      const size = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
      const raw = Number.isFinite(rawBytes as number) ? Math.max(0, Math.trunc(rawBytes as number)) : size;
      const entries = entriesFor(at);
      const wanted = trafficKey(direction, channel, type);
      // Once the key space is full, further kinds fold into one bucket rather
      // than letting an unexpected high-cardinality key grow without bound.
      const key = entries.has(wanted) || entries.size < maxKeys ? wanted : trafficKey(direction, channel, OVERFLOW_KEY);
      const entry = entries.get(key);
      if (entry) {
        entry.count += 1;
        entry.bytes += size;
        entry.rawBytes += raw;
        entry.max = Math.max(entry.max, size);
      } else {
        entries.set(key, { count: 1, bytes: size, rawBytes: raw, max: size });
      }
      trim();
    },

    drain(at = Date.now()) {
      const current = bucketStart(at);
      const ready: TrafficBucket[] = [];
      for (const [start, entries] of [...open.entries()]) {
        if (start >= current) continue;
        const bucket = toBucket(start, entries);
        ready.push(bucket);
        sealed.push(bucket);
        open.delete(start);
      }
      ready.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      trim();
      return ready;
    },

    buckets() {
      const live = [...open.entries()].map(([start, entries]) => toBucket(start, entries));
      return [...sealed, ...live].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    },

    rollup({ sinceMs, at = Date.now() } = {}) {
      const cutoff = sinceMs === undefined ? Number.NEGATIVE_INFINITY : at - Math.max(0, sinceMs);
      return rollupBuckets(this.buckets().filter((bucket) => Date.parse(bucket.startedAt) >= cutoff), bucketMs);
    },

    reset() {
      open = new Map();
      sealed = [];
    },
  };
}

function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

/**
 * Aggregate a set of buckets, wherever they came from -- memory, the daily
 * files, or both merged. Kept separate from the ledger so reading history off
 * disk does not have to replay it through a live recorder.
 */
export function rollupBuckets(buckets: readonly TrafficBucket[], bucketMs = DEFAULT_BUCKET_MS): TrafficRollup {
  const ordered = [...buckets].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const totals: TrafficEntry = { count: 0, bytes: 0, rawBytes: 0, max: 0 };
  const merged = new Map<string, TrafficEntry>();
  for (const bucket of ordered) {
    for (const [key, entry] of Object.entries(bucket.entries)) {
      const target = merged.get(key) ?? { count: 0, bytes: 0, rawBytes: 0, max: 0 };
      addInto(target, entry);
      merged.set(key, target);
      addInto(totals, entry);
    }
  }
  // Rates are over the buckets that exist, not over wall-clock since boot: a
  // service that was down contributed no seconds and must not dilute the rate.
  const seconds = Math.max(1, ordered.length * (Math.max(1_000, bucketMs) / 1_000));
  const entries = Object.fromEntries([...merged.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([key, entry]) => [key, {
      ...entry,
      perMinute: round(entry.count / (seconds / 60)),
      bytesPerSecond: round(entry.bytes / seconds),
    }]));
  return { from: ordered[0]?.startedAt ?? null, to: ordered.at(-1)?.startedAt ?? null, seconds, totals, entries };
}

function addInto(target: TrafficEntry, entry: TrafficEntry): void {
  target.count += entry.count;
  target.bytes += entry.bytes;
  target.rawBytes += entry.rawBytes;
  target.max = Math.max(target.max, entry.max);
}
