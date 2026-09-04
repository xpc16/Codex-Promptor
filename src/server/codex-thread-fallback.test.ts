import { describe, expect, it } from "vitest";
import { chooseResumeThread, durableThreadOrigin } from "./codex-thread-fallback.js";

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
