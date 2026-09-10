import { describe, expect, it, vi } from "vitest";
import { cachedResumeThread, resolveSavedCodexThread, rememberDurableThread, durableThreadOrigin } from "./codex-thread-fallback.js";

describe("which thread a switch records as its origin", () => {
  const base = { previousThreadId: "d4", previousIsDurable: true, carriedFromThreadId: null };

  it("records the thread being left when that thread was written", () => {
    expect(durableThreadOrigin(base)).toBe("d4");
  });

  it("keeps the older origin when the thread being left was never written", () => {
    // d4 -> d6 -> d7, where d6 was a thread/start that never received a first
    // prompt. Recording d6 here is what made d4 -- the thread holding 51 MB of
    // conversation -- unreachable from the tab that owned it.
    expect(durableThreadOrigin({
      previousThreadId: "d6",
      previousIsDurable: false,
      carriedFromThreadId: "d4",
    })).toBe("d4");
  });

  it("still records an undurable thread when there is nothing older", () => {
    expect(durableThreadOrigin({ ...base, previousIsDurable: false })).toBe("d4");
  });
});

describe("durable recovery pointers", () => {
  const id = "01a03d03-a43c-7c60-956b-5d50212c083e";

  it("keeps a durable origin through arbitrarily many empty switches", async () => {
    let session = { threadId: "a", lastDurableThreadId: null as string | null, lastThreadSwitch: null as { fromThreadId: string } | null };
    const probe = async (candidate: string) => candidate === "a";
    for (const target of ["b", "c", "d"]) {
      const lastDurableThreadId = await rememberDurableThread(session, target, probe);
      session = { threadId: target, lastDurableThreadId, lastThreadSwitch: { fromThreadId: session.threadId } };
      expect(session.lastDurableThreadId).toBe("a");
    }
    const persisted = JSON.parse(JSON.stringify(session));
    await expect(resolveSavedCodexThread(persisted, probe, async () => null)).resolves.toEqual({ threadId: "a", fellBack: true });
  });

  it("promotes a thread once written, but not on an unsuccessful probe", async () => {
    const session = { threadId: "b", lastDurableThreadId: "a", lastThreadSwitch: { fromThreadId: "older" } };
    expect(await rememberDurableThread(session, "b", async () => true)).toBe("b");
    expect(await rememberDurableThread(session, "c", async (candidate) => candidate === "a" || candidate === "older")).toBe("a");
    expect(await rememberDurableThread(session, "c", async () => { throw new Error("EPERM"); })).toBe("a");
  });

  it("checks only the current thread on a normal reopen", async () => {
    const probe = vi.fn().mockResolvedValue(true), cache = vi.fn();
    await expect(resolveSavedCodexThread({ threadId: "current", lastDurableThreadId: "old" }, probe, cache))
      .resolves.toEqual({ threadId: "current", fellBack: false });
    expect(probe).toHaveBeenCalledExactlyOnceWith("current");
    expect(cache).not.toHaveBeenCalled();
  });

  it("prefers the dedicated pointer, then legacy origin, then corroborated cache", async () => {
    const session = { threadId: "missing", lastDurableThreadId: "durable", lastThreadSwitch: { fromThreadId: "legacy" } };
    const cache = vi.fn().mockResolvedValue("cached");
    const choice = async (present: string[]) => resolveSavedCodexThread(session, async (candidate) => present.includes(candidate), cache);
    expect((await choice(["durable", "legacy", "cached"])).threadId).toBe("durable");
    expect((await choice(["legacy", "cached"])).threadId).toBe("legacy");
    expect(cache).not.toHaveBeenCalled();
    expect((await choice(["cached"])).threadId).toBe("cached");
    expect(cache).toHaveBeenCalledOnce();
  });

  it("does not guess another conversation when none of this tab's candidates exist", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    await expect(resolveSavedCodexThread({ threadId: "missing", lastDurableThreadId: "missing" }, probe, async () => null))
      .rejects.toThrow("CODEX_SESSION_NOT_SAVED");
    expect(probe).toHaveBeenCalledOnce();
  });

  it.each(["EPERM", "CODEX_ROLLOUT_ID_MISMATCH", "CODEX_ROLLOUT_IS_SUBAGENT"])("does not confuse %s with missing history", async (error) => {
    const cache = vi.fn();
    await expect(resolveSavedCodexThread({ threadId: "current", lastDurableThreadId: "old" }, async () => { throw new Error(error); }, cache))
      .rejects.toThrow(error);
    expect(cache).not.toHaveBeenCalled();
  });

  it("rejects a malformed cache or one that belongs to no recorded prompt", () => {
    expect(cachedResumeThread({ threadId: id }, [{ threadId: id }])).toBe(id);
    expect(cachedResumeThread({ threadId: id }, [{ threadId: "another-session" }])).toBeNull();
    expect(cachedResumeThread(null, [])).toBeNull();
    expect(cachedResumeThread({ threadId: "../../file" }, [{ threadId: "../../file" }])).toBeNull();
  });
});
