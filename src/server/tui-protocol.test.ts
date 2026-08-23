import { describe, expect, it, vi } from "vitest";
import { InitialTuiThreadGate, TuiThreadRequestTracker } from "./tui-protocol.js";

describe("TUI thread request tracking", () => {
  it("correlates a successful resume response", () => {
    const tracker = new TuiThreadRequestTracker();
    tracker.observeClientMessage(JSON.stringify({ id: 7, method: "thread/resume", params: { threadId: "thread-old", cwd: "D:\\live" } }));
    expect(tracker.observeServerMessage(JSON.stringify({ id: 7, result: { thread: { id: "thread-old", sessionId: "session-root", cwd: "C:\\work" } } }))).toEqual({
      method: "thread/resume",
      requestedThreadId: "thread-old",
      requestedCwd: "D:\\live",
      thread: { id: "thread-old", sessionId: "session-root", cwd: "C:\\work" },
    });
  });

  it("uses the new id returned by fork and ignores failed requests", () => {
    const tracker = new TuiThreadRequestTracker();
    tracker.observeClientMessage(JSON.stringify({ id: "fork-1", method: "thread/fork", params: { threadId: "source" } }));
    expect(tracker.observeServerMessage(JSON.stringify({ id: "fork-1", result: { thread: { id: "forked", forkedFromId: "source" } } }))?.thread.id).toBe("forked");

    tracker.observeClientMessage(JSON.stringify({ id: 9, method: "thread/resume", params: { threadId: "busy" } }));
    expect(tracker.observeServerMessage(JSON.stringify({ id: 9, error: { code: -32600, message: "active writer" } }))).toBeNull();
  });

  it("does not treat unrelated thread notifications or review traffic as a selection", () => {
    const tracker = new TuiThreadRequestTracker();
    tracker.observeClientMessage(JSON.stringify({ id: 4, method: "review/start", params: { delivery: "detached" } }));
    expect(tracker.observeServerMessage(JSON.stringify({ method: "thread/started", params: { thread: { id: "review-thread" } } }))).toBeNull();
    expect(tracker.observeServerMessage(JSON.stringify({ id: 4, result: { reviewThreadId: "review-thread" } }))).toBeNull();
  });
});

describe("initial TUI thread gate", () => {
  it("captures thread/start and holds later selections until the initial tab binding is ready", async () => {
    const onFollowing = vi.fn().mockResolvedValue(undefined);
    const gate = new InitialTuiThreadGate(onFollowing);
    const started = { method: "thread/start" as const, requestedThreadId: null, requestedCwd: "D:\\work", thread: { id: "thread-new" } };
    const resumed = { method: "thread/resume" as const, requestedThreadId: "thread-other", requestedCwd: "D:\\other", thread: { id: "thread-other" } };

    await gate.observe(started);
    await gate.observe(resumed);
    await expect(gate.wait(() => null, 100, 1)).resolves.toEqual(started);
    expect(onFollowing).not.toHaveBeenCalled();

    await gate.activate();
    expect(onFollowing).toHaveBeenCalledWith(resumed);
  });

  it("rejects a new-session bootstrap that selects anything other than thread/start", async () => {
    const gate = new InitialTuiThreadGate(vi.fn());
    await gate.observe({ method: "thread/resume", requestedThreadId: "old", requestedCwd: null, thread: { id: "old" } });
    await expect(gate.wait(() => null, 100, 1)).rejects.toThrow("TUI_NEW_THREAD_EXPECTED:thread/resume");
  });

  it("surfaces an early terminal exit while waiting for the TUI to create its thread", async () => {
    const gate = new InitialTuiThreadGate(vi.fn());
    await expect(gate.wait(() => "Codex TUI exited before the thread was attached (code 1).", 100, 1))
      .rejects.toThrow("Codex TUI exited before the thread was attached");
  });
});
