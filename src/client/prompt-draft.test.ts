import { describe, expect, it } from "vitest";
import {
  clearPromptDraft,
  createDraftStore,
  createSessionFormDraftStore,
  MAX_DRAFT_LENGTH,
  readPromptDraft,
  readSessionFormDraft,
  writePromptDraft,
  writeSessionFormDraft,
} from "./prompt-draft.js";

describe("prompt composer drafts", () => {
  it("survives the queue remounting when another page is opened", () => {
    const store = createDraftStore();
    writePromptDraft("tab-1", "half a thought", store);
    expect(readPromptDraft("tab-1", store)).toBe("half a thought");
  });

  it("keeps a separate draft per conversation", () => {
    const store = createDraftStore();
    writePromptDraft("tab-1", "for one", store);
    writePromptDraft("tab-2", "for the other", store);
    expect(readPromptDraft("tab-1", store)).toBe("for one");
    expect(readPromptDraft("tab-2", store)).toBe("for the other");
    expect(readPromptDraft("tab-3", store)).toBe("");
  });

  it("drops an abandoned draft instead of keeping an empty entry", () => {
    const store = createDraftStore();
    writePromptDraft("tab-1", "typed then deleted", store);
    writePromptDraft("tab-1", "   ", store);
    expect(readPromptDraft("tab-1", store)).toBe("");
  });

  it("clears only once the prompt has reached the list", () => {
    const store = createDraftStore();
    writePromptDraft("tab-1", "queued now", store);
    clearPromptDraft("tab-1", store);
    expect(readPromptDraft("tab-1", store)).toBe("");
  });

  it("caps a runaway draft rather than holding it whole", () => {
    const store = createDraftStore();
    writePromptDraft("tab-1", "x".repeat(MAX_DRAFT_LENGTH + 500), store);
    expect(readPromptDraft("tab-1", store)).toHaveLength(MAX_DRAFT_LENGTH);
  });

  it("keeps each page's drafts to itself", () => {
    // Two stores stand in for two browsers: nothing is shared through disk or
    // the server, so a draft typed on the phone never appears on the desktop.
    const phone = createDraftStore();
    const desktop = createDraftStore();
    writePromptDraft("tab-1", "typed on the phone", phone);
    expect(readPromptDraft("tab-1", desktop)).toBe("");
  });

  it("ignores a write with no conversation to attach it to", () => {
    const store = createDraftStore();
    writePromptDraft("", "orphan", store);
    expect(readPromptDraft("", store)).toBe("");
  });
});

describe("session setup page cache", () => {
  it("keeps setup fields per conversation without browser or server storage", () => {
    const store = createSessionFormDraftStore();
    const fallback = { provider: "codex" as const, mode: "new" as const, workingDirectory: "", resumeId: "" };
    writeSessionFormDraft("tab-1", { provider: "claude", mode: "resume", workingDirectory: "D:\\work", resumeId: "session-1" }, store);

    expect(readSessionFormDraft("tab-1", fallback, store)).toEqual({
      provider: "claude",
      mode: "resume",
      workingDirectory: "D:\\work",
      resumeId: "session-1",
    });
    expect(readSessionFormDraft("tab-2", fallback, store)).toEqual(fallback);
  });
});
