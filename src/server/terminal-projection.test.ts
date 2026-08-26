import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalScreenRow } from "../shared/terminal-protocol.js";
import type { TerminalScreenSnapshot, TerminalScreenSnapshotRow } from "./terminal-screen.js";
import { defaultProjectionSchedulerConfig, diffTerminalScreens, TerminalProjectionScheduler } from "./terminal-projection.js";

describe("projection screen diffs", () => {
  it("sends a full frame for a new generation or size epoch", () => {
    const first = snapshot(["one", "two"], { generation: "g1" });
    const next = snapshot(["one", "two"], { generation: "g2" });
    expect(diffTerminalScreens(null, first)).toMatchObject({ full: true, rows: [{ row: 0 }, { row: 1 }] });
    expect(diffTerminalScreens(first, next)).toMatchObject({ full: true, rows: [{ row: 0 }, { row: 1 }] });
  });

  it("detects a scroll region and sends only newly exposed or changed rows", () => {
    const previous = snapshot(["A", "B", "C", "D", "STATUS", "footer"]);
    const next = snapshot(["B", "C", "D", "E", "STATUS", "footer"], { revision: 2 });
    const diff = diffTerminalScreens(previous, next);
    expect(diff).toMatchObject({
      full: false,
      scroll: { top: 0, bottom: 3, lines: 1 },
      rows: [{ row: 3 }],
    });
    expect(diff?.rows[0].runs[0].text).toBe("E");
  });

  it("emits mode/cursor-only frames even when no cell changed", () => {
    const previous = snapshot(["ready"]);
    const next = snapshot(["ready"], {
      revision: 2,
      inputModes: { ...previous.inputModes, applicationCursorKeys: true },
      cursor: { row: 0, col: 2, visible: true },
    });
    expect(diffTerminalScreens(previous, next)).toMatchObject({ full: false, rows: [] });
  });
});

describe("TerminalProjectionScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces idle output and accelerates the interactive echo window", async () => {
    vi.useFakeTimers();
    let current = snapshot(["ready"]);
    const sent: any[] = [];
    const scheduler = new TerminalProjectionScheduler(async () => current, defaultProjectionSchedulerConfig);
    scheduler.subscribe("client", "tab", { viewportRows: 20, fps: 2 }, {
      isOpen: () => true,
      bufferedAmount: () => 0,
      send: (payload) => { sent.push(JSON.parse(payload)); return "sent"; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ full: true, sequence: 1 });

    current = snapshot(["idle update"], { revision: 2 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(499);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[1]).toMatchObject({ full: false, sequence: 2 });

    scheduler.markInteractive("tab");
    current = snapshot(["echo"], { revision: 3 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(34);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent[2]).toMatchObject({ full: false, sequence: 3 });
    scheduler.close();
  });

  it("keeps one latest state under backpressure and recovers with a full frame without a sequence gap", async () => {
    vi.useFakeTimers();
    let current = snapshot(["initial"]);
    let buffered = 0;
    const sent: any[] = [];
    const scheduler = new TerminalProjectionScheduler(async () => current, defaultProjectionSchedulerConfig);
    scheduler.subscribe("slow", "tab", {}, {
      isOpen: () => true,
      bufferedAmount: () => buffered,
      send: (payload) => { sent.push(JSON.parse(payload)); return "sent"; },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[0].sequence).toBe(1);

    buffered = defaultProjectionSchedulerConfig.backpressureHighBytes;
    current = snapshot(["stale intermediate"], { revision: 2 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(500);
    current = snapshot(["latest"], { revision: 3 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(1);

    buffered = defaultProjectionSchedulerConfig.backpressureLowBytes;
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ full: true, sequence: 2, revision: 3 });
    expect(sent[1].rows[0].runs[0].text).toBe("latest");
    scheduler.close();
  });

  it("defers screen candidates when the token bucket is empty and then sends the latest state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    let current = snapshot(["initial"]);
    const sent: any[] = [];
    const dropped: string[] = [];
    const scheduler = new TerminalProjectionScheduler(async () => current, {
      ...defaultProjectionSchedulerConfig,
      defaultFps: 5,
      bytesPerSecond: 256,
      maxBurstBytes: 128,
    });
    scheduler.subscribe("budget", "tab", { fps: 5 }, {
      isOpen: () => true,
      bufferedAmount: () => 0,
      send: (payload) => { sent.push(JSON.parse(payload)); return "sent"; },
      dropped: (reason) => dropped.push(reason),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);

    current = snapshot(["intermediate"], { revision: 2 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(1);
    expect(dropped).toContain("budget");

    current = snapshot(["latest"], { revision: 3 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent.at(-1)).toMatchObject({ sequence: 2, revision: 3 });
    expect(sent.at(-1).rows[0].runs[0].text).toBe("latest");
    scheduler.close();
  });

  it("allows a bounded interactive echo burst to borrow future tokens", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    let current = snapshot(["initial"]);
    const sent: any[] = [];
    const scheduler = new TerminalProjectionScheduler(async () => current, {
      ...defaultProjectionSchedulerConfig,
      bytesPerSecond: 256,
      maxBurstBytes: 1_024,
    });
    scheduler.subscribe("interactive", "tab", {}, {
      isOpen: () => true,
      bufferedAmount: () => 0,
      send: (payload) => { sent.push(JSON.parse(payload)); return "sent"; },
    });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.markInteractive("tab");
    current = snapshot(["echo"], { revision: 2 });
    scheduler.markDirty("tab");
    await vi.advanceTimersByTimeAsync(defaultProjectionSchedulerConfig.interactiveFrameMs);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ revision: 2, full: false });
    scheduler.close();
  });

  it("returns to the idle frame rate when an interactive command starts streaming", async () => {
    vi.useFakeTimers();
    let current = snapshot(["ready"]);
    const sent: any[] = [];
    const scheduler = new TerminalProjectionScheduler(async () => current, {
      ...defaultProjectionSchedulerConfig,
      interactiveOutputMaxBytes: 4,
    });
    scheduler.subscribe("stream", "tab", {}, {
      isOpen: () => true,
      bufferedAmount: () => 0,
      send: (payload) => { sent.push(JSON.parse(payload)); return "sent"; },
    });
    await vi.advanceTimersByTimeAsync(0);
    scheduler.markInteractive("tab");
    current = snapshot(["lots of output"], { revision: 2 });
    scheduler.markDirty("tab", 8);
    await vi.advanceTimersByTimeAsync(defaultProjectionSchedulerConfig.interactiveFrameMs);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500 - defaultProjectionSchedulerConfig.interactiveFrameMs);
    expect(sent).toHaveLength(2);
    scheduler.close();
  });
});

function snapshot(
  lines: string[],
  overrides: Partial<TerminalScreenSnapshot> = {},
): TerminalScreenSnapshot {
  const rows = lines.map((text, row) => screenRow(row, text));
  return {
    generation: "generation",
    revision: 1,
    sizeEpoch: 0,
    cols: 80,
    totalRows: Math.max(5, lines.length),
    viewportTop: 0,
    viewportRows: lines.length,
    alternateScreen: false,
    inputModes: {
      applicationCursorKeys: false,
      applicationKeypad: false,
      bracketedPaste: false,
      mouseTracking: "none",
      sendFocus: false,
    },
    cursor: { row: 0, col: 0, visible: true },
    rows,
    ...overrides,
  };
}

function screenRow(row: number, text: string): TerminalScreenSnapshotRow {
  const wire: TerminalScreenRow = {
    row,
    clearToEnd: true,
    runs: text ? [{ text, style: { fg: "default", bg: "default", flags: [] } }] : [],
  };
  return { ...wire, hash: JSON.stringify([false, wire.runs]) };
}
