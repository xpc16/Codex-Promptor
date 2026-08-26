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
  it("polls a lightweight summary and reads history once after the thread settles", async () => {
    const rpc = new CodexRpcClient();
    (rpc as any).turns.set("turn-polled", {
      threadId: "thread-polled",
      turnId: "turn-polled",
      turn: { id: "turn-polled", status: "inProgress" },
      items: [],
      startedAt: null,
    });
    rpc.readThreadSummary = vi.fn()
      .mockResolvedValueOnce({ thread: { id: "thread-polled", status: { type: "active" }, updatedAt: "2026-08-25T00:00:00Z" } })
      .mockResolvedValueOnce({ thread: { id: "thread-polled", status: { type: "idle" }, updatedAt: "2026-08-25T00:01:00Z" } });
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
    expect(rpc.readThreadSummary).toHaveBeenCalledTimes(2);
    expect(rpc.readThread).toHaveBeenCalledWith("thread-polled", expect.any(Number));
    expect(rpc.readThread).toHaveBeenCalledTimes(1);
  });

  it("does not repeatedly read full history while the settled summary is unchanged", async () => {
    const rpc = new CodexRpcClient();
    (rpc as any).turns.set("turn-stable", {
      threadId: "thread-stable",
      turnId: "turn-stable",
      turn: { id: "turn-stable", status: "inProgress" },
      items: [],
      startedAt: null,
    });
    let summaryReads = 0;
    rpc.readThreadSummary = vi.fn().mockImplementation(async () => {
      summaryReads += 1;
      if (summaryReads === 3) {
        (rpc as any).handleNotification("turn/completed", {
          threadId: "thread-stable",
          turn: { id: "turn-stable", status: "completed", items: [] },
        });
      }
      return { thread: { id: "thread-stable", status: { type: "idle" }, updatedAt: "stable" } };
    });
    rpc.readThread = vi.fn().mockResolvedValue({
      thread: { id: "thread-stable", turns: [{ id: "turn-stable", status: "inProgress", items: [] }] },
    });

    await expect(rpc.waitForTurn("turn-stable", 1_000, 0)).resolves.toMatchObject({ turnId: "turn-stable" });
    expect(rpc.readThreadSummary).toHaveBeenCalledTimes(3);
    expect(rpc.readThread).toHaveBeenCalledTimes(1);
  });

  it("clears a stale active-thread marker from an idle thread summary", async () => {
    const rpc = new CodexRpcClient();
    (rpc as any).activeThreads.add("thread-idle");
    rpc.readThreadSummary = vi.fn().mockResolvedValue({ thread: { id: "thread-idle", status: { type: "idle" } } });
    rpc.readThread = vi.fn();

    await expect(rpc.waitForThreadIdle("thread-idle", 1_000, 0)).resolves.toBeUndefined();
    expect(rpc.activeTurnIds("thread-idle")).toEqual([]);
    expect(rpc.readThreadSummary).toHaveBeenCalledWith("thread-idle", expect.any(Number));
    expect(rpc.readThread).not.toHaveBeenCalled();
  });
});

describe("context compaction notifications", () => {
  it("surfaces both current item events and the legacy thread event", () => {
    const rpc = new CodexRpcClient();
    const compacted = vi.fn();
    rpc.on("threadCompacted", compacted);

    (rpc as any).handleNotification("item/completed", {
      threadId: "thread-compact",
      turnId: "turn-compact",
      item: { id: "item-compact", type: "contextCompaction" },
    });
    (rpc as any).handleNotification("thread/compacted", {
      threadId: "thread-compact",
      turnId: "turn-compact",
    });

    expect(compacted).toHaveBeenNthCalledWith(1, expect.objectContaining({
      threadId: "thread-compact",
      turnId: "turn-compact",
      item: { id: "item-compact", type: "contextCompaction" },
    }));
    expect(compacted).toHaveBeenNthCalledWith(2, expect.objectContaining({
      threadId: "thread-compact",
      turnId: "turn-compact",
      item: null,
    }));
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
