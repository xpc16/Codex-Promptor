import { describe, expect, it, vi } from "vitest";
import { CodexRpcClient } from "./codex.js";

/**
 * A client whose transport is replaced, so the only thing under test is when a
 * call is allowed to reach the wire.
 */
function client() {
  const rpc = new CodexRpcClient();
  const sent: string[] = [];
  const gates = new Map<string, { release: (value?: unknown) => void; fail: (error: Error) => void }>();
  (rpc as any).request = (method: string) => {
    sent.push(method);
    return new Promise((resolve, reject) => {
      gates.set(method, { release: (value) => resolve(value ?? {}), fail: reject });
    });
  };
  return { rpc, sent, gates };
}

const settle = async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); };

describe("subscribing without making the tab wait", () => {
  it("returns before the subscription lands", async () => {
    const { rpc, sent } = client();
    // thread/resume ships the whole conversation back -- eleven seconds on the
    // largest conversations here -- and nothing on screen depends on it.
    rpc.subscribeThread("thread-1", "D:\\work");
    await settle();

    expect(sent).toEqual(["thread/resume"]);
    expect(rpc.hasPendingSubscription("thread-1")).toBe(true);
  });

  it("holds a dispatch until the subscription lands, then sends it", async () => {
    const { rpc, sent, gates } = client();
    rpc.subscribeThread("thread-1", "D:\\work");
    await settle();

    const started = rpc.startTurn("thread-1", "跑一下", "client-1", "D:\\work");
    await settle();
    // A turn started now would run with nobody listening for its completion,
    // so the queue would wait forever on an answer it could not hear.
    expect(sent).toEqual(["thread/resume"]);

    gates.get("thread/resume")!.release();
    await settle();
    expect(sent).toEqual(["thread/resume", "turn/start"]);

    gates.get("turn/start")!.release({ turnId: "turn-1" });
    expect(await started).toMatchObject({ turnId: "turn-1" });
  });

  it("holds a steer and an idle check the same way", async () => {
    const { rpc, sent, gates } = client();
    rpc.subscribeThread("thread-1", "D:\\work");
    await settle();

    void rpc.steerTurn("thread-1", "turn-1", "补一句", "client-2");
    // Before the subscription lands this connection has heard about no turns,
    // so "nothing is running" would be true of every thread.
    const idle = rpc.waitForThreadIdle("thread-1", 1_000);
    await settle();
    expect(sent).toEqual(["thread/resume"]);

    gates.get("thread/resume")!.release();
    await settle();
    expect(sent).toContain("turn/steer");
    await expect(idle).resolves.toBeUndefined();
  });

  it("fails a dispatch with the reason the subscription never landed", async () => {
    const { rpc, gates } = client();
    rpc.subscribeThread("thread-1", "D:\\work");
    await settle();
    const started = rpc.startTurn("thread-1", "跑一下", "client-1", "D:\\work");

    gates.get("thread/resume")!.fail(new Error("RPC_TIMEOUT:thread/resume"));

    // Hanging would leave the queue waiting on a tab that can never run
    // anything; the caller is told why instead.
    await expect(started).rejects.toThrow("RPC_TIMEOUT:thread/resume");
  });

  it("does not take the process down when nothing ever waits on a failure", async () => {
    const { rpc, gates } = client();
    const rejection = vi.fn();
    process.once("unhandledRejection", rejection);

    rpc.subscribeThread("thread-1", "D:\\work");
    await settle();
    gates.get("thread/resume")!.fail(new Error("RPC_TIMEOUT:thread/resume"));
    await settle();

    process.removeListener("unhandledRejection", rejection);
    expect(rejection).not.toHaveBeenCalled();
  });

  it("dispatches straight through for a thread that was never subscribed here", async () => {
    // Nothing is pending, so nothing is waited on -- a new thread's first turn
    // must not hang looking for a subscription that does not exist.
    const { rpc, sent, gates } = client();
    void rpc.startTurn("thread-new", "第一句", "client-1", "D:\\work");
    await settle();
    expect(sent).toEqual(["turn/start"]);
    gates.get("turn/start")!.release({ turnId: "turn-1" });
  });

  it("forgets a subscription that belonged to a closed socket", async () => {
    // Keeping it would let a later dispatch believe it is subscribed on a
    // connection that no longer exists.
    const { rpc, gates } = client();
    rpc.subscribeThread("thread-1", "D:\\work");
    await settle();
    gates.get("thread/resume")!.release();
    await settle();
    expect(rpc.hasPendingSubscription("thread-1")).toBe(true);

    rpc.close();
    expect(rpc.hasPendingSubscription("thread-1")).toBe(false);
  });
});
