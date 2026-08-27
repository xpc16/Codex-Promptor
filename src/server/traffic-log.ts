import { promises as fs } from "node:fs";
import path from "node:path";
import type { TrafficBucket } from "./traffic-ledger.js";

/**
 * Sealed buckets, appended to a daily file so a week of ordinary use survives
 * restarts. The in-memory window only answers "today"; the question this whole
 * exercise exists for -- which bytes did nobody need -- needs longer than that.
 *
 * Append-only JSONL, one line per minute, and only for minutes that carried
 * traffic: an idle service writes nothing at all. A busy day is on the order
 * of a megabyte, and files past the retention window are deleted.
 */
export const DEFAULT_RETAINED_DAYS = 14;

const FILE_PREFIX = "traffic-";
const FILE_SUFFIX = ".jsonl";

export type TrafficLogOptions = {
  retainedDays?: number;
};

export type TrafficLog = {
  readonly directory: string;
  append(buckets: readonly TrafficBucket[]): Promise<void>;
  /** Buckets from the daily files, oldest first. Used to read past what memory holds. */
  read(sinceMs?: number, now?: number): Promise<TrafficBucket[]>;
  prune(now?: number): Promise<void>;
  clear(): Promise<void>;
};

export function trafficLogFileName(at: number): string {
  return `${FILE_PREFIX}${new Date(at).toISOString().slice(0, 10)}${FILE_SUFFIX}`;
}

export function createTrafficLog(dataDir: string, options: TrafficLogOptions = {}): TrafficLog {
  const directory = path.join(dataDir, "diagnostics");
  const retainedDays = Math.max(1, Math.trunc(options.retainedDays ?? DEFAULT_RETAINED_DAYS));

  return {
    directory,

    async append(buckets) {
      if (buckets.length === 0) return;
      // Buckets can straddle midnight, so group by the day each one belongs to
      // rather than by the day it happens to be written.
      const byFile = new Map<string, string[]>();
      for (const bucket of buckets) {
        if (Object.keys(bucket.entries).length === 0) continue;
        const at = Date.parse(bucket.startedAt);
        if (!Number.isFinite(at)) continue;
        const file = trafficLogFileName(at);
        const lines = byFile.get(file) ?? [];
        lines.push(JSON.stringify(bucket));
        byFile.set(file, lines);
      }
      if (byFile.size === 0) return;
      await fs.mkdir(directory, { recursive: true });
      for (const [file, lines] of byFile) {
        // Diagnostics must never take the service down: a full disk or a
        // locked file costs us a minute of measurement, nothing more.
        try { await fs.appendFile(path.join(directory, file), `${lines.join("\n")}\n`, "utf8"); }
        catch { /* measurement is best-effort */ }
      }
    },

    async read(sinceMs, now = Date.now()) {
      const cutoff = sinceMs === undefined ? Number.NEGATIVE_INFINITY : now - Math.max(0, sinceMs);
      let names: string[];
      try { names = await fs.readdir(directory); }
      catch { return []; }
      const buckets: TrafficBucket[] = [];
      for (const name of names.filter(isLogFile).sort()) {
        if (dayEnd(name) < cutoff) continue;
        let contents: string;
        try { contents = await fs.readFile(path.join(directory, name), "utf8"); }
        catch { continue; }
        for (const line of contents.split("\n")) {
          if (!line.trim()) continue;
          try {
            const bucket = JSON.parse(line) as TrafficBucket;
            if (!bucket?.startedAt || !bucket.entries) continue;
            if (Date.parse(bucket.startedAt) < cutoff) continue;
            buckets.push(bucket);
          } catch { /* a torn final line after a crash is not worth failing over */ }
        }
      }
      buckets.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      return buckets;
    },

    async prune(now = Date.now()) {
      const cutoff = now - retainedDays * 86_400_000;
      let names: string[];
      try { names = await fs.readdir(directory); }
      catch { return; }
      for (const name of names.filter(isLogFile)) {
        if (dayEnd(name) >= cutoff) continue;
        try { await fs.rm(path.join(directory, name), { force: true }); }
        catch { /* it will be retried tomorrow */ }
      }
    },

    async clear() {
      let names: string[];
      try { names = await fs.readdir(directory); }
      catch { return; }
      for (const name of names.filter(isLogFile)) {
        try { await fs.rm(path.join(directory, name), { force: true }); }
        catch { /* best-effort */ }
      }
    },
  };
}

function isLogFile(name: string): boolean {
  return name.startsWith(FILE_PREFIX) && name.endsWith(FILE_SUFFIX) && Number.isFinite(dayStart(name));
}

function dayStart(name: string): number {
  return Date.parse(`${name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length)}T00:00:00.000Z`);
}

/** A file is worth keeping until the end of the day it covers, not its start. */
function dayEnd(name: string): number {
  return dayStart(name) + 86_400_000 - 1;
}
