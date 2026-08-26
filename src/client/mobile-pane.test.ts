import { describe, expect, it } from "vitest";
import { MOBILE_PANES, nextMobilePane, swipeDirection } from "./mobile-pane.js";

describe("mobile pane paging", () => {
  it("pages left towards the terminal and right towards the console", () => {
    expect(swipeDirection({ dx: -120, dy: 4 })).toBe(1);
    expect(swipeDirection({ dx: 120, dy: -6 })).toBe(-1);
  });

  it("ignores taps and short drags", () => {
    expect(swipeDirection({ dx: 0, dy: 0 })).toBe(0);
    expect(swipeDirection({ dx: -40, dy: 2 })).toBe(0);
  });

  it("leaves mostly-vertical gestures to the pane's own scrolling", () => {
    expect(swipeDirection({ dx: -70, dy: 260 })).toBe(0);
    expect(swipeDirection({ dx: 70, dy: -260 })).toBe(0);
  });

  it("still pages on a diagonal that leans clearly sideways", () => {
    expect(swipeDirection({ dx: -140, dy: 60 })).toBe(1);
  });

  it("steps through the panes in console-to-terminal order", () => {
    expect(nextMobilePane("console", 1)).toBe("conversation");
    expect(nextMobilePane("conversation", 1)).toBe("queue");
    expect(nextMobilePane("queue", 1)).toBe("terminal");
    expect(nextMobilePane("terminal", -1)).toBe("queue");
  });

  it("clamps at both ends instead of wrapping around", () => {
    expect(nextMobilePane("console", -1)).toBe("console");
    expect(nextMobilePane("terminal", 1)).toBe("terminal");
    expect(nextMobilePane("queue", 0)).toBe("queue");
  });

  it("keeps the strip order the pane bar renders", () => {
    expect([...MOBILE_PANES]).toEqual(["console", "conversation", "queue", "terminal"]);
  });
});
