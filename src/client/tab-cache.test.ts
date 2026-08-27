import { describe, expect, it } from "vitest";
import type { TabBundle } from "../shared/schemas.js";
import { INITIAL_ANSWER_WINDOW, INITIAL_PROMPT_WINDOW } from "../shared/tab-window.js";
import { createTabCache, windowLimits } from "./tab-cache.js";

function bundle(tabId: string, window?: TabBundle["window"]): TabBundle {
  return {
    tab: { id: tabId } as TabBundle["tab"],
    prompts: { revision: 1, updatedAt: "now", prompts: [] } as unknown as TabBundle["prompts"],
    answers: { revision: 1, updatedAt: "now", answers: [] } as unknown as TabBundle["answers"],
    runtime: { revision: 1 } as unknown as TabBundle["runtime"],
    ...(window ? { window } : {}),
  };
}

describe("window limits", () => {
  it("falls back to the opening window when the read was not bounded", () => {
    expect(windowLimits(bundle("a"))).toEqual({ promptLimit: INITIAL_PROMPT_WINDOW, answerLimit: INITIAL_ANSWER_WINDOW });
  });

  it("remembers how far back the reader has scrolled", () => {
    const limits = windowLimits(bundle("a", { prompts: { start: 60, total: 120, completed: 50 }, answers: { start: 90, total: 119 } }));
    expect(limits).toEqual({ promptLimit: 60, answerLimit: 29 });
  });
});

describe("tab cache", () => {
  it("returns what it was given and nothing for an unknown tab", () => {
    const cache = createTabCache();
    cache.remember(bundle("a"));
    expect(cache.get("a")?.bundle.tab.id).toBe("a");
    expect(cache.get("b")).toBeNull();
  });

  it("evicts the least recently used conversation past the limit", () => {
    const cache = createTabCache(2);
    cache.remember(bundle("a"));
    cache.remember(bundle("b"));
    cache.get("a");
    cache.remember(bundle("c"));
    expect(cache.size()).toBe(2);
    expect(cache.get("a")).not.toBeNull();
    expect(cache.get("b")).toBeNull();
  });

  it("drops conversations that no longer exist", () => {
    const cache = createTabCache();
    cache.remember(bundle("a"));
    cache.remember(bundle("b"));
    cache.retain(new Set(["b"]));
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).not.toBeNull();
  });

  it("forgets a deleted conversation", () => {
    const cache = createTabCache();
    cache.remember(bundle("a"));
    cache.forget("a");
    expect(cache.size()).toBe(0);
  });
});
