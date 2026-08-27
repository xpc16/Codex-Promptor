import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrafficLog, trafficLogFileName } from "./traffic-log.js";
import type { TrafficBucket } from "./traffic-ledger.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promptor-traffic-"));
  roots.push(root);
  return root;
}

const bucket = (startedAt: string, bytes = 100): TrafficBucket => ({
  startedAt,
  entries: { "out:ws:terminal.screen": { count: 1, bytes, rawBytes: bytes, max: bytes } },
});

const DAY = 86_400_000;

describe("daily file names", () => {
  it("names a file after the UTC day the bucket belongs to", () => {
    expect(trafficLogFileName(Date.parse("2026-08-27T23:59:00.000Z"))).toBe("traffic-2026-08-27.jsonl");
    expect(trafficLogFileName(Date.parse("2026-08-28T00:00:00.000Z"))).toBe("traffic-2026-08-28.jsonl");
  });
});

describe("appending", () => {
  it("writes one line per bucket and reads them back", async () => {
    const log = createTrafficLog(await temporaryRoot());
    await log.append([bucket("2026-08-27T10:00:00.000Z"), bucket("2026-08-27T10:01:00.000Z", 250)]);

    const read = await log.read();
    expect(read.map((item) => item.startedAt)).toEqual([
      "2026-08-27T10:00:00.000Z",
      "2026-08-27T10:01:00.000Z",
    ]);
    expect(read[1].entries["out:ws:terminal.screen"].bytes).toBe(250);
  });

  it("writes nothing for an idle minute", async () => {
    const log = createTrafficLog(await temporaryRoot());
    await log.append([{ startedAt: "2026-08-27T10:00:00.000Z", entries: {} }]);
    await log.append([]);
    expect(await log.read()).toEqual([]);
  });

  it("files a bucket by its own day, not the day it is written", async () => {
    const log = createTrafficLog(await temporaryRoot());
    await log.append([bucket("2026-08-27T23:59:00.000Z"), bucket("2026-08-28T00:00:00.000Z")]);
    const names = (await fs.readdir(log.directory)).sort();
    expect(names).toEqual(["traffic-2026-08-27.jsonl", "traffic-2026-08-28.jsonl"]);
  });

  it("appends across calls instead of overwriting", async () => {
    const log = createTrafficLog(await temporaryRoot());
    await log.append([bucket("2026-08-27T10:00:00.000Z")]);
    await log.append([bucket("2026-08-27T10:05:00.000Z")]);
    expect(await log.read()).toHaveLength(2);
  });

  it("survives a torn final line from a crash", async () => {
    const root = await temporaryRoot();
    const log = createTrafficLog(root);
    await log.append([bucket("2026-08-27T10:00:00.000Z")]);
    await fs.appendFile(path.join(log.directory, "traffic-2026-08-27.jsonl"), '{"startedAt":"2026-08', "utf8");
    expect(await log.read()).toHaveLength(1);
  });
});

describe("reading a window", () => {
  it("returns only buckets inside it", async () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const log = createTrafficLog(await temporaryRoot());
    await log.append([
      bucket(new Date(now - 3 * DAY).toISOString()),
      bucket(new Date(now - 60_000).toISOString()),
    ]);
    const recent = await log.read(2 * DAY, now);
    expect(recent).toHaveLength(1);
    expect(recent[0].startedAt).toBe(new Date(now - 60_000).toISOString());
  });

  it("is empty rather than failing before anything was written", async () => {
    expect(await createTrafficLog(await temporaryRoot()).read()).toEqual([]);
  });
});

describe("pruning", () => {
  it("deletes files past the retention window and keeps the rest", async () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const log = createTrafficLog(await temporaryRoot(), { retainedDays: 3 });
    await log.append([
      bucket(new Date(now - 10 * DAY).toISOString()),
      bucket(new Date(now - 1 * DAY).toISOString()),
    ]);

    await log.prune(now);

    const names = await fs.readdir(log.directory);
    expect(names).toEqual([trafficLogFileName(now - 1 * DAY)]);
  });

  it("keeps a file until the end of the day it covers", async () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const log = createTrafficLog(await temporaryRoot(), { retainedDays: 1 });
    // Written early on the 26th: its day ends within the window, so it stays.
    await log.append([bucket("2026-08-26T01:00:00.000Z")]);
    await log.prune(now);
    expect(await fs.readdir(log.directory)).toEqual(["traffic-2026-08-26.jsonl"]);
  });

  it("clears everything on request", async () => {
    const log = createTrafficLog(await temporaryRoot());
    await log.append([bucket("2026-08-27T10:00:00.000Z")]);
    await log.clear();
    expect(await log.read()).toEqual([]);
  });
});
