import { describe, expect, it } from "vitest";
import { terminalSubscriptionWanted } from "./terminal-visibility.js";

describe("whether a terminal stream should be subscribed", () => {
  const base = { hidden: false, documentVisible: false, active: true };

  it("drops the stream while nobody is looking", () => {
    // A hidden page keeps receiving every byte while requestAnimationFrame --
    // what the write queue yields on -- stops firing, so the backlog is
    // replayed frame by frame on return instead of landing on the last screen.
    expect(terminalSubscriptionWanted({ ...base, hidden: true })).toBe(false);
    expect(terminalSubscriptionWanted(base)).toBe(true);
  });

  it("leaves an open document alone", () => {
    // The document view already unsubscribed, and it re-enters through its own
    // one-shot when it closes. Two owners of one subscription fight.
    expect(terminalSubscriptionWanted({ ...base, documentVisible: true })).toBe(false);
  });

  it("wants nothing for a tab with no socket", () => {
    expect(terminalSubscriptionWanted({ ...base, active: false })).toBe(false);
  });

  it("is a state, so a missed event cannot strand a page unsubscribed", () => {
    // Driving this from transitions meant a page that opened hidden, or that
    // never saw the event turning it visible, stayed unsubscribed for good:
    // a terminal that showed "waiting for output" and never loaded. Asking
    // what is wanted now gives the same answer however it got here.
    const visible = { hidden: false, documentVisible: false, active: true };
    expect(terminalSubscriptionWanted(visible)).toBe(true);
    expect(terminalSubscriptionWanted(visible)).toBe(true);
  });
});
