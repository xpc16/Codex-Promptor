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
/**
 * `ws` and `http` count application messages; `wire` counts what a socket
 * actually wrote or read over an interval.
 *
 * They are separate channels because they answer different questions and are
 * measured differently. On a plaintext connection a `ws` entry has
 * `rawBytes === bytes` by construction -- the sender knows one number, the
 * serialized payload -- so its ratio is 1 and means nothing. A `wire` entry
 * carries a real compression ratio, because there `bytes` is the socket delta
 * and `rawBytes` is the sum of the payloads that produced it.
 *
 * An encrypted connection moves that ratio: compression happens inside the
 * seal, so a `ws` entry's `bytes` is the sealed frame and `rawBytes` is the
 * JSON that went into it -- and the `wire` ratio falls to about 1, which is
 * what permessage-deflate is worth against ciphertext.
 */
export type TrafficChannel = "ws" | "http" | "wire";

/** Fixed size classes, in bytes. Upper bound of each class; the last is unbounded. */
export const SIZE_CLASSES = [256, 1024, 4096, 16_384, 65_536, 262_144, 1_048_576, Number.POSITIVE_INFINITY] as const;

export type TrafficEntry = {
  /** Messages or responses. */
  count: number;
  /** Bytes as they left this process: post-compression for HTTP, pre-deflate for WebSocket. */
  bytes: number;
  /** Bytes before any compression, so the ratio is visible. Meaningful on the `wire` channel only. */
  rawBytes: number;
  /** The single largest one seen, which is how outliers get found. */
  max: number;
  /**
   * How many fell into each size class, aligned with SIZE_CLASSES.
   *
   * A mean hides the shape that matters most here: 500 MB can be a million
   * small frames or four hundred snapshots, and the two call for opposite
   * fixes. Optional so buckets written before this existed still parse.
   */
  sizes?: number[];
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
/** Route patterns, message types and three network scopes are a small fixed set; this only guards a bug. */
export const DEFAULT_MAX_KEYS = 400;
/** 24h of one-minute buckets, so a day is always answerable without reading files. */
export const DEFAULT_RETAINED_BUCKETS = 1_440;

export const OVERFLOW_KEY = "other";

export type TrafficLedgerOptions = {
  bucketMs?: number;
  maxKeys?: number;
  retainedBuckets?: number;
};

export type TrafficLedger = {
  record(direction: TrafficDirection, channel: TrafficChannel, type: string, bytes: number, options?: TrafficRecordOptions): void;
  /** Buckets that are complete as of `at`, removed from the pending set so a writer can append them once. */
  drain(at?: number): TrafficBucket[];
  /** The rolling in-memory window, oldest first, including the bucket still filling. */
  buckets(): TrafficBucket[];
  rollup(options?: { sinceMs?: number; at?: number }): TrafficRollup;
  reset(): void;
};

export type TrafficRecordOptions = {
  /** Bytes before compression. Defaults to `bytes`; only the `wire` channel has a different value. */
  rawBytes?: number;
  /** Which link this travelled over. Omitted for records that are not per-connection. */
  scope?: string;
  at?: number;
};

export function trafficKey(direction: TrafficDirection, channel: TrafficChannel, type: string, scope?: string): string {
  const cleaned = String(type).trim().replace(/\s+/g, " ").slice(0, 120) || "unknown";
  const link = scope ? `${String(scope).trim().slice(0, 16)}:` : "";
  return `${direction}:${channel}:${link}${cleaned}`;
}

export function sizeClassIndex(bytes: number): number {
  for (let index = 0; index < SIZE_CLASSES.length; index += 1) {
    if (bytes <= SIZE_CLASSES[index]) return index;
  }
  return SIZE_CLASSES.length - 1;
}

function emptySizes(): number[] {
  return new Array(SIZE_CLASSES.length).fill(0);
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
    entries: Object.fromEntries([...entries.entries()].map(([key, entry]) => [key, { ...entry, ...(entry.sizes ? { sizes: [...entry.sizes] } : {}) }])),
  });

  return {
    record(direction, channel, type, bytes, options = {}) {
      const { rawBytes, scope, at = Date.now() } = options;
      const size = Number.isFinite(bytes) ? Math.max(0, Math.trunc(bytes)) : 0;
      const raw = Number.isFinite(rawBytes as number) ? Math.max(0, Math.trunc(rawBytes as number)) : size;
      const entries = entriesFor(at);
      const wanted = trafficKey(direction, channel, type, scope);
      // Once the key space is full, further kinds fold into one bucket rather
      // than letting an unexpected high-cardinality key grow without bound.
      const key = entries.has(wanted) || entries.size < maxKeys ? wanted : trafficKey(direction, channel, OVERFLOW_KEY);
      const entry = entries.get(key);
      if (entry) {
        entry.count += 1;
        entry.bytes += size;
        entry.rawBytes += raw;
        entry.max = Math.max(entry.max, size);
        (entry.sizes ??= emptySizes())[sizeClassIndex(size)] += 1;
      } else {
        const sizes = emptySizes();
        sizes[sizeClassIndex(size)] = 1;
        entries.set(key, { count: 1, bytes: size, rawBytes: raw, max: size, sizes });
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
  if (!entry.sizes) return;
  target.sizes ??= new Array(SIZE_CLASSES.length).fill(0);
  for (let index = 0; index < entry.sizes.length && index < target.sizes.length; index += 1) {
    target.sizes[index] += entry.sizes[index] ?? 0;
  }
}
