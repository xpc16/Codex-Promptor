import { describe, expect, it } from "vitest";
import { terminalVisibilityAction } from "./terminal-visibility.js";

describe("terminal subscription across page visibility", () => {
  const base = { hidden: false, documentVisible: false, projectionMode: false, active: true };

  it("drops the stream while nobody is looking", () => {
    // A hidden page keeps receiving every byte while requestAnimationFrame --
    // what the write queue yields on -- stops firing, so the backlog is
    // replayed frame by frame on return instead of landing on the last screen.
    expect(terminalVisibilityAction({ ...base, hidden: true })).toBe("unsubscribe");
    expect(terminalVisibilityAction({ ...base, hidden: false })).toBe("resubscribe");
  });

  it("leaves an open document alone", () => {
    // The document view already unsubscribed, and it re-enters through its own
    // one-shot when it closes. Two owners of one subscription fight.
    expect(terminalVisibilityAction({ ...base, hidden: true, documentVisible: true })).toBe("none");
    expect(terminalVisibilityAction({ ...base, documentVisible: true })).toBe("none");
  });

  it("does nothing for a tab with no socket", () => {
    expect(terminalVisibilityAction({ ...base, hidden: true, active: false })).toBe("none");
  });

  it("still applies in projection mode, which has frames of its own to resume", () => {
    expect(terminalVisibilityAction({ ...base, hidden: true, projectionMode: true })).toBe("unsubscribe");
    expect(terminalVisibilityAction({ ...base, projectionMode: true })).toBe("resubscribe");
  });
});
