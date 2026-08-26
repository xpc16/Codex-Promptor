import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BoundedWebSocketSender,
  decodeTerminalInput,
  RawTerminalBatcher,
  TerminalTrafficMeter,
  defaultTerminalTransportConfig,
  terminalTransportConfigFromEnv,
} from "./terminal-transport.js";

describe("raw terminal batching", () => {
  afterEach(() => vi.useRealTimers());

  it("coalesces adjacent chunks without changing offsets or bytes", () => {
    vi.useFakeTimers();
    const delivered: any[] = [];
    const batcher = new RawTerminalBatcher((chunk) => delivered.push(chunk));
    batcher.push(chunk("tab-1", "generation-1", 10, "abc"));
    batcher.push(chunk("tab-1", "generation-1", 13, "def"));

    vi.advanceTimersByTime(defaultTerminalTransportConfig.rawBatchIdleMs - 1);
    expect(delivered).toHaveLength(0);
    vi.advanceTimersByTime(1);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ startOffset: 10, endOffset: 16, generation: "generation-1" });
    expect(Buffer.from(delivered[0].dataBase64, "base64").toString("utf8")).toBe("abcdef");
  });

  it("flushes a discontinuity and switches to the interactive delay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
    const delivered: any[] = [];
    const batcher = new RawTerminalBatcher((value) => delivered.push(value));
    batcher.push(chunk("tab-1", "generation-1", 0, "old"));
    batcher.push(chunk("tab-1", "generation-2", 0, "new"));
    expect(delivered).toHaveLength(1);
    expect(Buffer.from(delivered[0].dataBase64, "base64").toString("utf8")).toBe("old");

    batcher.markInteractive("tab-1");
    vi.advanceTimersByTime(defaultTerminalTransportConfig.rawBatchInteractiveMs);
    expect(delivered).toHaveLength(2);
    expect(Buffer.from(delivered[1].dataBase64, "base64").toString("utf8")).toBe("new");
  });
});

describe("bounded WebSocket sending and traffic metrics", () => {
  it("records payload bytes without retaining content", () => {
    const meter = new TerminalTrafficMeter();
    const socket = fakeSocket();
    const id = meter.register(socket);
    const sender = new BoundedWebSocketSender(meter);

    expect(sender.send(id, socket, JSON.stringify({ type: "terminal.output", secret: "do-not-store" }), "terminal.raw")).toBe(true);
    const snapshot = meter.snapshot();
    expect(snapshot.totals.terminalMessages).toBe(1);
    expect(snapshot.totals.terminalBytes).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("do-not-store");
  });

  it("closes a raw stream instead of growing an already congested queue", () => {
    const config = { ...defaultTerminalTransportConfig, websocketHighWaterBytes: 100 };
    const meter = new TerminalTrafficMeter();
    const socket = fakeSocket();
    socket.bufferedAmount = 100;
    const id = meter.register(socket);
    const sender = new BoundedWebSocketSender(meter, config);

    expect(sender.send(id, socket, "raw", "terminal.raw")).toBe(false);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1013, "terminal_backpressure");
    expect(meter.snapshot().totals.backpressureClosures).toBe(1);
  });
});

describe("terminal transport validation", () => {
  it("accepts bounded Base64 and rejects malformed or oversized input", () => {
    expect(decodeTerminalInput(Buffer.from("方向键\u001b[A", "utf8").toString("base64"), 64)).toBe("方向键\u001b[A");
    expect(decodeTerminalInput("not base64", 64)).toBeNull();
    expect(decodeTerminalInput(Buffer.alloc(65).toString("base64"), 64)).toBeNull();
  });

  it("clamps environment overrides", () => {
    const config = terminalTransportConfigFromEnv({
      CODEX_PROMPTOR_WS_HIGH_WATER_BYTES: "1",
      CODEX_PROMPTOR_RAW_BATCH_IDLE_MS: "75",
      CODEX_PROMPTOR_MAX_INPUT_BYTES: "131072",
      CODEX_PROMPTOR_PROJECTION_BYTES_PER_SECOND: "4096",
      CODEX_PROMPTOR_PROJECTION_MAX_BURST_BYTES: "16384",
    });
    expect(config.websocketHighWaterBytes).toBe(16 * 1024);
    expect(config.rawBatchIdleMs).toBe(75);
    expect(config.maxInputMessageBytes).toBe(128 * 1024);
    expect(config.projectionBytesPerSecond).toBe(4 * 1024);
    expect(config.projectionMaxBurstBytes).toBe(16 * 1024);
  });
});

function chunk(tabId: string, generation: string, startOffset: number, value: string) {
  const data = Buffer.from(value, "utf8");
  return {
    tabId,
    generation,
    startOffset,
    endOffset: startOffset + data.length,
    dataBase64: data.toString("base64"),
  };
}

function fakeSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    extensions: "permessage-deflate",
    send: vi.fn(),
    close: vi.fn(),
  };
}
