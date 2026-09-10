import { describe, expect, it } from "vitest";
import { cachedResumeThread, chooseResumeThread, durableThreadOrigin } from "./codex-thread-fallback.js";

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

describe("which thread a reopen resumes", () => {
  const base = { threadId: "d7", fallbackThreadId: "d4", threadHasRollout: true, fallbackHasRollout: true };

  it("repairs legacy chains with the tab's corroborated, durable cache", () => {
    const evidence = { ...base, cachedThreadId: "d1", cachedHasRollout: true };
    expect(chooseResumeThread(evidence).threadId).toBe("d7");
    expect(chooseResumeThread({ ...evidence, threadHasRollout: false }).threadId).toBe("d4");
    expect(chooseResumeThread({ ...evidence, threadHasRollout: false, fallbackHasRollout: false }))
      .toEqual({ threadId: "d1", fellBack: true });
    expect(chooseResumeThread({ ...evidence, threadHasRollout: false, fallbackHasRollout: false, cachedHasRollout: false }))
      .toEqual({ threadId: "d7", fellBack: false });
  });

  it("rejects a malformed cache or one that belongs to no recorded prompt", () => {
    const id = "01a03d03-a43c-7c60-956b-5d50212c083e";
    expect(cachedResumeThread({ threadId: id }, [{ threadId: id }])).toBe(id);
    expect(cachedResumeThread({ threadId: id }, [{ threadId: "another-session" }])).toBeNull();
    expect(cachedResumeThread({ threadId: id }, [{ threadId: null }])).toBeNull();
    expect(cachedResumeThread(null, [])).toBeNull();
    expect(cachedResumeThread({ threadId: "../../file" }, [{ threadId: "../../file" }])).toBeNull();
  });

  it("resumes the stored thread whenever it has a rollout", () => {
    expect(chooseResumeThread(base)).toEqual({ threadId: "d7", fellBack: false });
  });

  it("falls back when the stored thread was never written", () => {
    // The failure this replaces: "Codex TUI exited before the session was
    // attached (code 1)", which says nothing about the conversation still
    // being on disk under the previous id.
    expect(chooseResumeThread({ ...base, threadHasRollout: false }))
      .toEqual({ threadId: "d4", fellBack: true });
  });

  it("does not fall back onto a thread that was never written either", () => {
    expect(chooseResumeThread({ ...base, threadHasRollout: false, fallbackHasRollout: false }))
      .toEqual({ threadId: "d7", fellBack: false });
  });

  it("does not fall back with no origin recorded", () => {
    expect(chooseResumeThread({ ...base, threadHasRollout: false, fallbackThreadId: null }))
      .toEqual({ threadId: "d7", fellBack: false });
  });

  it("ignores an origin that is the stored thread itself", () => {
    expect(chooseResumeThread({ threadId: "d7", fallbackThreadId: "d7", threadHasRollout: false, fallbackHasRollout: true }))
      .toEqual({ threadId: "d7", fellBack: false });
  });
});
