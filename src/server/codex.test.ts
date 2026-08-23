import { describe, expect, it, vi } from "vitest";
import { CodexRpcClient, waitForThreadLoaded } from "./codex.js";

describe("remote TUI attach", () => {
  it("waits until the TUI has loaded the thread before returning", async () => {
    const readThreadSummary = vi.fn()
      .mockResolvedValueOnce({ thread: { id: "thread-1", status: { type: "notLoaded" } } })
      .mockResolvedValueOnce({ thread: { id: "thread-1", status: { type: "idle" } } });

    await expect(waitForThreadLoaded({ readThreadSummary } as any, "thread-1", 1_000, 0)).resolves.toMatchObject({
      id: "thread-1",
      status: { type: "idle" },
    });
    expect(readThreadSummary).toHaveBeenCalledTimes(2);
  });

  it("accepts a genuinely active restored thread", async () => {
    const readThreadSummary = vi.fn().mockResolvedValue({ thread: { id: "thread-2", status: { type: "active", activeFlags: ["turn"] } } });
    await expect(waitForThreadLoaded({ readThreadSummary } as any, "thread-2", 1_000, 0)).resolves.toMatchObject({ status: { type: "active" } });
  });
});

describe("turn completion recovery", () => {
  it("polls thread history when the controller misses the completion notification", async () => {
    const rpc = new CodexRpcClient();
    (rpc as any).turns.set("turn-polled", {
      threadId: "thread-polled",
      turnId: "turn-polled",
      turn: { id: "turn-polled", status: "inProgress" },
      items: [],
      startedAt: null,
    });
    rpc.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: "thread-polled",
        turns: [{
          id: "turn-polled",
          status: "completed",
          items: [{ type: "agentMessage", phase: "final_answer", text: "已完成" }],
        }],
      },
    });

    await expect(rpc.waitForTurn("turn-polled", 1_000, 0)).resolves.toMatchObject({
      threadId: "thread-polled",
      turnId: "turn-polled",
      turn: { status: "completed" },
    });
    expect(rpc.readThread).toHaveBeenCalledWith("thread-polled", expect.any(Number));
  });

  it("clears a stale active-thread marker from an idle thread snapshot", async () => {
    const rpc = new CodexRpcClient();
    (rpc as any).activeThreads.add("thread-idle");
    rpc.readThread = vi.fn().mockResolvedValue({ thread: { id: "thread-idle", status: { type: "idle" }, turns: [] } });

    await expect(rpc.waitForThreadIdle("thread-idle", 1_000, 0)).resolves.toBeUndefined();
    expect(rpc.activeTurnIds("thread-idle")).toEqual([]);
    expect(rpc.readThread).toHaveBeenCalledWith("thread-idle", expect.any(Number));
  });
});

describe("thread release", () => {
  it("unsubscribes every thread loaded by the controller", async () => {
    const rpc = new CodexRpcClient();
    Object.defineProperty(rpc, "connected", { get: () => true });
    const request = vi.spyOn(rpc, "request").mockImplementation(async (method) => {
      if (method === "thread/loaded/list") return { data: ["thread-1", "thread-2"], nextCursor: null };
      return { status: "unsubscribed" };
    });

    await rpc.releaseLoadedThreads();

    expect(request).toHaveBeenCalledWith("thread/loaded/list", { limit: 1_000 }, 2_000);
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "thread-1" }, 2_000);
    expect(request).toHaveBeenCalledWith("thread/unsubscribe", { threadId: "thread-2" }, 2_000);
  });
});
