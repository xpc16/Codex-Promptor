import { describe, expect, it } from "vitest";
import { isMobilePane, MOBILE_PANES } from "./mobile-pane.js";

describe("mobile panes", () => {
  it("keeps the strip order the pane bar renders", () => {
    expect([...MOBILE_PANES]).toEqual(["console", "conversation", "queue", "terminal"]);
  });

  it("recognises a pane name and rejects anything else", () => {
    expect(isMobilePane("queue")).toBe(true);
    expect(isMobilePane("terminal")).toBe(true);
    expect(isMobilePane("answers")).toBe(false);
    expect(isMobilePane(null)).toBe(false);
  });
});
