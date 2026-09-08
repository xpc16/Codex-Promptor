import { terminalInputIsPlain } from "../shared/terminal-input.js";
import { randomUUID } from "node:crypto";
export { TERMINAL_PROTOCOL_VERSION } from "../shared/terminal-protocol.js";

export type TerminalTrafficKind =
  | "index"
  | "state"
  | "snapshot"
  | "terminal.raw"
  | "terminal.snapshot"
  | "terminal.projection"
  | "error";

export type TerminalTransportConfig = {
  websocketHighWaterBytes: number;
  websocketLowWaterBytes: number;
  maxInputMessageBytes: number;
  rawBatchIdleMs: number;
  rawBatchInteractiveMs: number;
  interactiveWindowMs: number;
  interactiveOutputMaxBytes: number;
  rawBatchMaxBytes: number;
  projectionBytesPerSecond: number;
  projectionMaxBurstBytes: number;
};

export const defaultTerminalTransportConfig: TerminalTransportConfig = {
  websocketHighWaterBytes: 256 * 1024,
  websocketLowWaterBytes: 64 * 1024,
  maxInputMessageBytes: 64 * 1024,
  rawBatchIdleMs: 50,
  rawBatchInteractiveMs: 12,
  interactiveWindowMs: 800,
  interactiveOutputMaxBytes: 8 * 1024,
  rawBatchMaxBytes: 64 * 1024,
  projectionBytesPerSecond: 2 * 1024,
  projectionMaxBurstBytes: 8 * 1024,
};

export function terminalTransportConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TerminalTransportConfig {
  return {
    websocketHighWaterBytes: integerEnv(env.CODEX_PROMPTOR_WS_HIGH_WATER_BYTES, 16 * 1024, 16 * 1024 * 1024, defaultTerminalTransportConfig.websocketHighWaterBytes),
    websocketLowWaterBytes: integerEnv(env.CODEX_PROMPTOR_WS_LOW_WATER_BYTES, 4 * 1024, 4 * 1024 * 1024, defaultTerminalTransportConfig.websocketLowWaterBytes),
    maxInputMessageBytes: integerEnv(env.CODEX_PROMPTOR_MAX_INPUT_BYTES, 1024, 1024 * 1024, defaultTerminalTransportConfig.maxInputMessageBytes),
    rawBatchIdleMs: integerEnv(env.CODEX_PROMPTOR_RAW_BATCH_IDLE_MS, 0, 1_000, defaultTerminalTransportConfig.rawBatchIdleMs),
    rawBatchInteractiveMs: integerEnv(env.CODEX_PROMPTOR_RAW_BATCH_INTERACTIVE_MS, 0, 250, defaultTerminalTransportConfig.rawBatchInteractiveMs),
    interactiveWindowMs: integerEnv(env.CODEX_PROMPTOR_INTERACTIVE_WINDOW_MS, 0, 10_000, defaultTerminalTransportConfig.interactiveWindowMs),
    interactiveOutputMaxBytes: integerEnv(env.CODEX_PROMPTOR_INTERACTIVE_OUTPUT_MAX_BYTES, 1024, 1024 * 1024, defaultTerminalTransportConfig.interactiveOutputMaxBytes),
    rawBatchMaxBytes: integerEnv(env.CODEX_PROMPTOR_RAW_BATCH_MAX_BYTES, 1024, 1024 * 1024, defaultTerminalTransportConfig.rawBatchMaxBytes),
    projectionBytesPerSecond: integerEnv(env.CODEX_PROMPTOR_PROJECTION_BYTES_PER_SECOND, 256, 1024 * 1024, defaultTerminalTransportConfig.projectionBytesPerSecond),
    projectionMaxBurstBytes: integerEnv(env.CODEX_PROMPTOR_PROJECTION_MAX_BURST_BYTES, 1024, 1024 * 1024, defaultTerminalTransportConfig.projectionMaxBurstBytes),
  };
}

export type RawTerminalChunk = {
  tabId: string;
  generation: string;
  startOffset: number;
  endOffset: number;
  dataBase64: string;
};

type PendingRawBatch = {
  generation: string;
  startOffset: number;
  endOffset: number;
  chunks: Buffer[];
  byteLength: number;
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number;
};

/**
 * Coalesces adjacent PTY chunks without changing byte order or cursor offsets.
 * A tab has at most one pending batch, so a noisy TUI cannot create an
 * unbounded application-level queue before WebSocket backpressure is checked.
 */
export class RawTerminalBatcher {
  private readonly pending = new Map<string, PendingRawBatch>();
  private readonly interactiveUntil = new Map<string, number>();
  private readonly interactiveOutputBytes = new Map<string, number>();

  constructor(
    private readonly deliver: (chunk: RawTerminalChunk) => void,
    private readonly config: TerminalTransportConfig = defaultTerminalTransportConfig,
    private readonly now: () => number = Date.now,
  ) {}

  push(chunk: RawTerminalChunk): void {
    const bytes = Buffer.from(chunk.dataBase64, "base64");
    if (bytes.length === 0 && chunk.endOffset <= chunk.startOffset) return;
    if ((this.interactiveUntil.get(chunk.tabId) ?? 0) > this.now()) {
      const outputBytes = (this.interactiveOutputBytes.get(chunk.tabId) ?? 0) + bytes.length;
      this.interactiveOutputBytes.set(chunk.tabId, outputBytes);
      if (outputBytes >= this.config.interactiveOutputMaxBytes) this.interactiveUntil.delete(chunk.tabId);
    }
    let batch = this.pending.get(chunk.tabId);
    if (batch && (batch.generation !== chunk.generation || batch.endOffset !== chunk.startOffset)) {
      this.flush(chunk.tabId);
      batch = undefined;
    }
    if (!batch) {
      batch = {
        generation: chunk.generation,
        startOffset: chunk.startOffset,
        endOffset: chunk.startOffset,
        chunks: [],
        byteLength: 0,
        timer: null,
        dueAt: 0,
      };
      this.pending.set(chunk.tabId, batch);
    }
    batch.chunks.push(bytes);
    batch.byteLength += bytes.length;
    batch.endOffset = chunk.endOffset;
    if (batch.byteLength >= this.config.rawBatchMaxBytes) {
      this.flush(chunk.tabId);
      return;
    }
    this.schedule(chunk.tabId, batch, this.currentDelay(chunk.tabId));
  }

  markInteractive(tabId: string): void {
    this.interactiveUntil.set(tabId, this.now() + this.config.interactiveWindowMs);
    this.interactiveOutputBytes.set(tabId, 0);
    const batch = this.pending.get(tabId);
    if (batch) this.schedule(tabId, batch, this.config.rawBatchInteractiveMs);
  }

  flush(tabId: string): void {
    const batch = this.pending.get(tabId);
    if (!batch) return;
    this.pending.delete(tabId);
    if (batch.timer) clearTimeout(batch.timer);
    const data = batch.chunks.length === 1 ? batch.chunks[0] : Buffer.concat(batch.chunks, batch.byteLength);
    this.deliver({
      tabId,
      generation: batch.generation,
      startOffset: batch.startOffset,
      endOffset: batch.endOffset,
      dataBase64: data.toString("base64"),
    });
  }

  close(flush = true): void {
    for (const tabId of [...this.pending.keys()]) {
      if (flush) this.flush(tabId);
      else {
        const batch = this.pending.get(tabId);
        if (batch?.timer) clearTimeout(batch.timer);
        this.pending.delete(tabId);
      }
    }
    this.interactiveUntil.clear();
    this.interactiveOutputBytes.clear();
  }

  private currentDelay(tabId: string): number {
    if ((this.interactiveUntil.get(tabId) ?? 0) > this.now()) return this.config.rawBatchInteractiveMs;
    this.interactiveUntil.delete(tabId);
    this.interactiveOutputBytes.delete(tabId);
    return this.config.rawBatchIdleMs;
  }

  private schedule(tabId: string, batch: PendingRawBatch, delay: number): void {
    const dueAt = this.now() + delay;
    if (batch.timer && batch.dueAt <= dueAt) return;
    if (batch.timer) clearTimeout(batch.timer);
    batch.dueAt = dueAt;
    batch.timer = setTimeout(() => this.flush(tabId), Math.max(0, delay));
    batch.timer.unref?.();
  }
}

type SocketLike = {
  readyState: number;
  bufferedAmount?: number;
  extensions?: string;
  send(payload: string | Uint8Array, options?: { compress?: boolean }): void;
  close(code?: number, reason?: string): void;
};

/**
 * A sealed frame is high-entropy, so permessage-deflate can only make it
 * bigger while spending CPU to do it. Compression that pays for itself now
 * happens inside the seal, before the ciphertext exists.
 */
const payloadBytes = (payload: string | Uint8Array): number =>
  typeof payload === "string" ? Buffer.byteLength(payload, "utf8") : payload.length;

type TrafficCounters = {
  messages: number;
  payloadBytes: number;
  terminalMessages: number;
  terminalBytes: number;
  stateMessages: number;
  stateBytes: number;
  snapshots: number;
  backpressureClosures: number;
  projectionCandidatesDropped: number;
  peakBufferedAmount: number;
};

type ConnectionTraffic = TrafficCounters & {
  id: string;
  connectedAt: string;
  role: "unknown" | "state" | "terminal" | "mixed";
  compression: string | null;
};

const emptyCounters = (): TrafficCounters => ({
  messages: 0,
  payloadBytes: 0,
  terminalMessages: 0,
  terminalBytes: 0,
  stateMessages: 0,
  stateBytes: 0,
  snapshots: 0,
  backpressureClosures: 0,
  projectionCandidatesDropped: 0,
  peakBufferedAmount: 0,
});

/** Stores byte counts only; terminal, prompt and answer contents are never retained. */
export class TerminalTrafficMeter {
  private startedAt = new Date().toISOString();
  private totals = emptyCounters();
  private readonly connections = new Map<string, ConnectionTraffic>();

  register(socket: Pick<SocketLike, "extensions">): string {
    const id = randomUUID();
    this.connections.set(id, {
      id,
      connectedAt: new Date().toISOString(),
      role: "unknown",
      compression: socket.extensions || null,
      ...emptyCounters(),
    });
    return id;
  }

  unregister(id: string): void {
    this.connections.delete(id);
  }

  setRole(id: string, hasState: boolean, hasTerminal: boolean): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.role = hasState && hasTerminal ? "mixed" : hasTerminal ? "terminal" : hasState ? "state" : "unknown";
  }

  recordSend(id: string, kind: TerminalTrafficKind, payloadBytes: number, bufferedAmount: number): void {
    const connection = this.connections.get(id);
    this.bump(this.totals, kind, payloadBytes, bufferedAmount);
    if (connection) this.bump(connection, kind, payloadBytes, bufferedAmount);
  }

  recordBackpressureClosure(id: string, bufferedAmount: number): void {
    this.totals.backpressureClosures += 1;
    this.totals.peakBufferedAmount = Math.max(this.totals.peakBufferedAmount, bufferedAmount);
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.backpressureClosures += 1;
    connection.peakBufferedAmount = Math.max(connection.peakBufferedAmount, bufferedAmount);
  }

  recordProjectionCandidateDropped(id: string, bufferedAmount: number): void {
    this.totals.projectionCandidatesDropped += 1;
    this.totals.peakBufferedAmount = Math.max(this.totals.peakBufferedAmount, bufferedAmount);
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.projectionCandidatesDropped += 1;
    connection.peakBufferedAmount = Math.max(connection.peakBufferedAmount, bufferedAmount);
  }

  reset(): void {
    this.startedAt = new Date().toISOString();
    this.totals = emptyCounters();
    for (const connection of this.connections.values()) Object.assign(connection, emptyCounters());
  }

  snapshot(): { startedAt: string; totals: TrafficCounters; activeConnections: ConnectionTraffic[] } {
    return {
      startedAt: this.startedAt,
      totals: { ...this.totals },
      activeConnections: [...this.connections.values()].map((connection) => ({ ...connection })),
    };
  }

  private bump(target: TrafficCounters, kind: TerminalTrafficKind, payloadBytes: number, bufferedAmount: number): void {
    target.messages += 1;
    target.payloadBytes += payloadBytes;
    target.peakBufferedAmount = Math.max(target.peakBufferedAmount, bufferedAmount);
    if (kind.startsWith("terminal.")) {
      target.terminalMessages += 1;
      target.terminalBytes += payloadBytes;
    } else {
      target.stateMessages += 1;
      target.stateBytes += payloadBytes;
    }
    if (kind === "snapshot" || kind === "terminal.snapshot") target.snapshots += 1;
  }
}

export class BoundedWebSocketSender {
  constructor(
    private readonly meter: TerminalTrafficMeter,
    private readonly config: TerminalTransportConfig = defaultTerminalTransportConfig,
  ) {}

  send(id: string, socket: SocketLike, payload: string | Uint8Array, kind: TerminalTrafficKind): boolean {
    if (socket.readyState !== 1) return false;
    const bufferedAmount = Number.isFinite(socket.bufferedAmount) ? Number(socket.bufferedAmount) : 0;
    const terminalStream = kind.startsWith("terminal.");
    if (terminalStream && bufferedAmount >= this.config.websocketHighWaterBytes) {
      this.meter.recordBackpressureClosure(id, bufferedAmount);
      try { socket.close(1013, "terminal_backpressure"); } catch { /* socket already failed */ }
      return false;
    }
    try {
      socket.send(payload, typeof payload === "string" ? undefined : { compress: false });
      this.meter.recordSend(id, kind, payloadBytes(payload), bufferedAmount);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Projection is latest-state synchronization: under backpressure it drops
   * candidates and later sends one fresh full frame instead of closing the
   * stream or queueing stale screens in ws.
   */
  sendProjection(id: string, socket: SocketLike, payload: string | Uint8Array): "sent" | "backpressured" | "closed" {
    if (socket.readyState !== 1) return "closed";
    const bufferedAmount = Number.isFinite(socket.bufferedAmount) ? Number(socket.bufferedAmount) : 0;
    if (bufferedAmount >= this.config.websocketHighWaterBytes) {
      this.meter.recordProjectionCandidateDropped(id, bufferedAmount);
      return "backpressured";
    }
    try {
      socket.send(payload, typeof payload === "string" ? undefined : { compress: false });
      this.meter.recordSend(id, "terminal.projection", payloadBytes(payload), bufferedAmount);
      return "sent";
    } catch {
      return "closed";
    }
  }
}

/** Text accepted as sent, under the same ceiling the base64 form gets. */
export function plainTerminalInput(text: unknown, maxBytes: number): string | null {
  if (typeof text !== "string" || text.length === 0) return null;
  if (Buffer.byteLength(text, "utf8") > maxBytes) return null;
  return terminalInputIsPlain(text) ? text : null;
}

export function decodeTerminalInput(dataBase64: unknown, maxBytes: number): string | null {
  if (typeof dataBase64 !== "string" || dataBase64.length === 0) return null;
  // Base64 expands by 4/3. Reject before allocating the decoded Buffer.
  if (dataBase64.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64) || dataBase64.length % 4 !== 0) return null;
  const decoded = Buffer.from(dataBase64, "base64");
  if (decoded.length > maxBytes) return null;
  return decoded.toString("utf8");
}

function integerEnv(value: string | undefined, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}
