import { randomUUID } from "node:crypto";
import type { TerminalScreenFrame, TerminalScreenRow, TerminalScreenScroll } from "../shared/terminal-protocol.js";
import type { TerminalScreenSnapshot, TerminalScreenSnapshotRow } from "./terminal-screen.js";

export type ProjectionSendResult = "sent" | "backpressured" | "closed";

export type ProjectionSink = {
  isOpen: () => boolean;
  bufferedAmount: () => number;
  send: (payload: string) => ProjectionSendResult;
  dropped?: (reason: "backpressure" | "budget", payloadBytes?: number) => void;
};

export type ProjectionSchedulerConfig = {
  defaultViewportRows: number;
  defaultFps: number;
  interactiveFrameMs: number;
  interactiveWindowMs: number;
  backpressureHighBytes: number;
  backpressureLowBytes: number;
  backpressurePollMs: number;
  bytesPerSecond: number;
  maxBurstBytes: number;
};

export const defaultProjectionSchedulerConfig: ProjectionSchedulerConfig = {
  defaultViewportRows: 20,
  defaultFps: 2,
  interactiveFrameMs: 35,
  interactiveWindowMs: 800,
  backpressureHighBytes: 256 * 1024,
  backpressureLowBytes: 64 * 1024,
  backpressurePollMs: 100,
  bytesPerSecond: 2 * 1024,
  maxBurstBytes: 8 * 1024,
};

type ProjectionStream = {
  clientId: string;
  tabId: string;
  streamId: string;
  sequence: number;
  viewportRows: number;
  fps: number;
  sink: ProjectionSink;
  previous: TerminalScreenSnapshot | null;
  dirty: boolean;
  fullRequested: boolean;
  needsBackpressureRecovery: boolean;
  interactiveUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  timerDueAt: number;
  flushing: boolean;
  disposed: boolean;
  tokens: number;
  tokensRefilledAt: number;
};

/**
 * Per-client projection scheduler. It coalesces parser revisions, calculates
 * row/scroll diffs and implements latest-state backpressure recovery.
 */
export class TerminalProjectionScheduler {
  private readonly streams = new Map<string, ProjectionStream>();
  private readonly byTab = new Map<string, Set<string>>();

  constructor(
    private readonly takeSnapshot: (tabId: string, viewportRows: number) => Promise<TerminalScreenSnapshot | null>,
    private readonly config: ProjectionSchedulerConfig = defaultProjectionSchedulerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  subscribe(clientId: string, tabId: string, options: { viewportRows?: number; fps?: number }, sink: ProjectionSink): { streamId: string; viewportRows: number; fps: number } {
    this.unsubscribe(clientId, tabId);
    const stream: ProjectionStream = {
      clientId,
      tabId,
      streamId: randomUUID(),
      sequence: 0,
      viewportRows: clampInteger(options.viewportRows, 5, 60, this.config.defaultViewportRows),
      fps: clampInteger(options.fps, 1, 5, this.config.defaultFps),
      sink,
      previous: null,
      dirty: true,
      fullRequested: true,
      needsBackpressureRecovery: false,
      interactiveUntil: 0,
      timer: null,
      timerDueAt: 0,
      flushing: false,
      disposed: false,
      tokens: this.config.maxBurstBytes,
      tokensRefilledAt: this.now(),
    };
    const key = streamKey(clientId, tabId);
    this.streams.set(key, stream);
    const tabStreams = this.byTab.get(tabId) ?? new Set<string>();
    tabStreams.add(key);
    this.byTab.set(tabId, tabStreams);
    this.schedule(stream, 0);
    return { streamId: stream.streamId, viewportRows: stream.viewportRows, fps: stream.fps };
  }

  unsubscribe(clientId: string, tabId: string): void {
    const key = streamKey(clientId, tabId);
    const stream = this.streams.get(key);
    if (!stream) return;
    stream.disposed = true;
    if (stream.timer) clearTimeout(stream.timer);
    this.streams.delete(key);
    const tabStreams = this.byTab.get(tabId);
    tabStreams?.delete(key);
    if (tabStreams?.size === 0) this.byTab.delete(tabId);
  }

  unsubscribeClient(clientId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.clientId === clientId) this.unsubscribe(clientId, stream.tabId);
    }
  }

  markDirty(tabId: string): void {
    this.visitTab(tabId, (stream) => {
      stream.dirty = true;
      this.schedule(stream, this.frameDelay(stream));
    });
  }

  markInteractive(tabId: string): void {
    this.visitTab(tabId, (stream) => {
      stream.interactiveUntil = this.now() + this.config.interactiveWindowMs;
      if (stream.dirty) this.schedule(stream, this.config.interactiveFrameMs);
    });
  }

  forceFull(tabId: string): void {
    this.visitTab(tabId, (stream) => {
      stream.fullRequested = true;
      stream.dirty = true;
      this.schedule(stream, 0);
    });
  }

  requestFull(clientId: string, tabId: string): boolean {
    const stream = this.streams.get(streamKey(clientId, tabId));
    if (!stream) return false;
    stream.fullRequested = true;
    stream.dirty = true;
    this.schedule(stream, 0);
    return true;
  }

  has(clientId: string, tabId: string): boolean { return this.streams.has(streamKey(clientId, tabId)); }

  close(): void {
    for (const stream of this.streams.values()) {
      stream.disposed = true;
      if (stream.timer) clearTimeout(stream.timer);
    }
    this.streams.clear();
    this.byTab.clear();
  }

  private visitTab(tabId: string, visit: (stream: ProjectionStream) => void): void {
    for (const key of this.byTab.get(tabId) ?? []) {
      const stream = this.streams.get(key);
      if (stream) visit(stream);
    }
  }

  private frameDelay(stream: ProjectionStream): number {
    return stream.interactiveUntil > this.now()
      ? this.config.interactiveFrameMs
      : Math.max(1, Math.round(1_000 / stream.fps));
  }

  private schedule(stream: ProjectionStream, delay: number): void {
    if (stream.disposed || stream.flushing) return;
    const dueAt = this.now() + Math.max(0, delay);
    if (stream.timer && stream.timerDueAt <= dueAt) return;
    if (stream.timer) clearTimeout(stream.timer);
    stream.timerDueAt = dueAt;
    stream.timer = setTimeout(() => {
      stream.timer = null;
      void this.flush(stream);
    }, Math.max(0, delay));
    stream.timer.unref?.();
  }

  private async flush(stream: ProjectionStream): Promise<void> {
    if (stream.disposed || stream.flushing || !stream.sink.isOpen()) return;
    if (stream.needsBackpressureRecovery && stream.sink.bufferedAmount() > this.config.backpressureLowBytes) {
      this.schedule(stream, this.config.backpressurePollMs);
      return;
    }
    if (!stream.dirty && !stream.fullRequested) return;
    if (stream.sink.bufferedAmount() >= this.config.backpressureHighBytes) {
      if (!stream.needsBackpressureRecovery) stream.sink.dropped?.("backpressure");
      stream.needsBackpressureRecovery = true;
      stream.fullRequested = true;
      stream.dirty = true;
      this.schedule(stream, this.config.backpressurePollMs);
      return;
    }

    stream.flushing = true;
    stream.dirty = false;
    try {
      const snapshot = await this.takeSnapshot(stream.tabId, stream.viewportRows);
      if (!snapshot || stream.disposed || !stream.sink.isOpen()) return;
      const forceFull = stream.fullRequested || stream.needsBackpressureRecovery;
      const diff = diffTerminalScreens(stream.previous, snapshot, forceFull);
      if (!diff) return;
      const nextSequence = stream.sequence + 1;
      const frame: TerminalScreenFrame = {
        type: "terminal.screen",
        tabId: stream.tabId,
        streamId: stream.streamId,
        sequence: nextSequence,
        generation: snapshot.generation,
        revision: snapshot.revision,
        full: diff.full,
        cols: snapshot.cols,
        totalRows: snapshot.totalRows,
        viewportTop: snapshot.viewportTop,
        viewportRows: snapshot.viewportRows,
        alternateScreen: snapshot.alternateScreen,
        sizeEpoch: snapshot.sizeEpoch,
        inputModes: snapshot.inputModes,
        cursor: snapshot.cursor,
        rows: diff.rows,
        ...(diff.scroll ? { scroll: diff.scroll } : {}),
      };
      const payload = JSON.stringify(frame);
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const budgetDelay = this.consumeBudget(stream, payloadBytes, stream.previous === null || stream.needsBackpressureRecovery);
      if (budgetDelay > 0) {
        stream.dirty = true;
        stream.sink.dropped?.("budget", payloadBytes);
        this.schedule(stream, budgetDelay);
        return;
      }
      const result = stream.sink.send(payload);
      if (result === "backpressured") {
        stream.needsBackpressureRecovery = true;
        stream.fullRequested = true;
        stream.dirty = true;
        return;
      }
      if (result !== "sent") return;
      stream.sequence = nextSequence;
      stream.previous = snapshot;
      stream.fullRequested = false;
      stream.needsBackpressureRecovery = false;
    } finally {
      stream.flushing = false;
      if (stream.disposed) return;
      if (stream.needsBackpressureRecovery) this.schedule(stream, this.config.backpressurePollMs);
      else if (stream.dirty) this.schedule(stream, this.frameDelay(stream));
    }
  }

  private consumeBudget(stream: ProjectionStream, payloadBytes: number, recoveryFrame: boolean): number {
    const now = this.now();
    const elapsedMs = Math.max(0, now - stream.tokensRefilledAt);
    stream.tokens = Math.min(
      this.config.maxBurstBytes,
      stream.tokens + (elapsedMs / 1_000) * this.config.bytesPerSecond,
    );
    stream.tokensRefilledAt = now;
    if (recoveryFrame) {
      stream.tokens = Math.max(0, stream.tokens - payloadBytes);
      return 0;
    }
    // A single full-width styled frame can be larger than the burst capacity.
    // Requiring one full bucket still bounds its frequency while guaranteeing
    // that a large but valid screen eventually makes progress.
    const required = Math.min(payloadBytes, this.config.maxBurstBytes);
    if (stream.tokens >= required) {
      stream.tokens = Math.max(0, stream.tokens - payloadBytes);
      return 0;
    }
    return Math.max(1, Math.ceil(((required - stream.tokens) / this.config.bytesPerSecond) * 1_000));
  }
}

export type TerminalScreenDiff = { full: boolean; rows: TerminalScreenRow[]; scroll?: TerminalScreenScroll };

export function diffTerminalScreens(previous: TerminalScreenSnapshot | null, next: TerminalScreenSnapshot, forceFull = false): TerminalScreenDiff | null {
  const structurallyDifferent = !previous
    || previous.generation !== next.generation
    || previous.sizeEpoch !== next.sizeEpoch
    || previous.cols !== next.cols
    || previous.totalRows !== next.totalRows
    || previous.viewportTop !== next.viewportTop
    || previous.viewportRows !== next.viewportRows
    || previous.alternateScreen !== next.alternateScreen;
  if (forceFull || structurallyDifferent) return { full: true, rows: next.rows.map(stripHash) };

  const regularDirty = next.rows.filter((row, index) => row.hash !== previous.rows[index]?.hash);
  const scroll = detectScroll(previous.rows, next.rows, regularDirty.length);
  const rows = scroll
    ? dirtyAfterScroll(previous.rows, next.rows, scroll)
    : regularDirty;
  const metadataChanged = JSON.stringify(previous.inputModes) !== JSON.stringify(next.inputModes)
    || JSON.stringify(previous.cursor) !== JSON.stringify(next.cursor);
  if (rows.length === 0 && !metadataChanged && !scroll) return null;
  return {
    full: false,
    rows: rows.map(stripHash),
    ...(scroll ? { scroll } : {}),
  };
}

/** Finds a proven contiguous row shift that reduces the resulting dirty set. */
export function detectScroll(previous: TerminalScreenSnapshotRow[], next: TerminalScreenSnapshotRow[], regularDirtyCount: number): TerminalScreenScroll | undefined {
  const count = Math.min(previous.length, next.length);
  if (count < 4 || regularDirtyCount < 3) return undefined;
  let best: { scroll: TerminalScreenScroll; dirty: number; matched: number } | undefined;
  const maxShift = Math.min(10, count - 1);
  for (let amount = 1; amount <= maxShift; amount += 1) {
    for (const direction of [1, -1] as const) {
      const offset = amount * direction;
      let start = 0;
      while (start < count) {
        const previousIndex = start + offset;
        if (previousIndex < 0 || previousIndex >= count || next[start].hash !== previous[previousIndex].hash) { start += 1; continue; }
        let end = start + 1;
        let movedContent = previous[start]?.hash !== previous[previousIndex]?.hash;
        while (end < count) {
          const compared = end + offset;
          if (compared < 0 || compared >= count || next[end].hash !== previous[compared].hash) break;
          if (previous[end]?.hash !== previous[compared]?.hash) movedContent = true;
          end += 1;
        }
        const matched = end - start;
        if (matched >= 3 && movedContent) {
          const top = direction > 0 ? start : Math.max(0, start - amount);
          const bottom = direction > 0 ? Math.min(count - 1, end + amount - 1) : Math.min(count - 1, end - 1);
          const scroll: TerminalScreenScroll = { top, bottom, lines: direction > 0 ? amount : -amount };
          const dirty = dirtyAfterScroll(previous, next, scroll).length;
          if (dirty <= regularDirtyCount - 2 && (!best || dirty < best.dirty || (dirty === best.dirty && matched > best.matched))) {
            best = { scroll, dirty, matched };
          }
        }
        start = end;
      }
    }
  }
  return best?.scroll;
}

function dirtyAfterScroll(previous: TerminalScreenSnapshotRow[], next: TerminalScreenSnapshotRow[], scroll: TerminalScreenScroll): TerminalScreenSnapshotRow[] {
  const hashes = previous.map((row) => row.hash);
  const { top, bottom, lines } = scroll;
  if (lines > 0) {
    for (let row = top; row <= bottom - lines; row += 1) hashes[row] = hashes[row + lines];
    for (let row = Math.max(top, bottom - lines + 1); row <= bottom; row += 1) hashes[row] = "";
  } else {
    const amount = Math.abs(lines);
    for (let row = bottom; row >= top + amount; row -= 1) hashes[row] = hashes[row - amount];
    for (let row = top; row < Math.min(bottom + 1, top + amount); row += 1) hashes[row] = "";
  }
  return next.filter((row, index) => row.hash !== hashes[index]);
}

function stripHash(row: TerminalScreenSnapshotRow): TerminalScreenRow {
  const { hash: _hash, ...wireRow } = row;
  return wireRow;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(numeric)));
}

function streamKey(clientId: string, tabId: string): string { return `${clientId}\u0000${tabId}`; }
