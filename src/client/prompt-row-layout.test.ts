import { describe, expect, it } from "vitest";
import { promptActionsNeedOwnRow } from "./prompt-row-layout.js";

describe("prompt row action placement", () => {
  const metrics = { hasHardLineBreak: false, fullWidth: 400, actionWidth: 120, gap: 7 };

  it("keeps controls inline while the prompt fits before them", () => {
    expect(promptActionsNeedOwnRow({ ...metrics, textWidth: 272 })).toBe(false);
  });

  it("moves the whole action bar below as soon as the prompt touches it", () => {
    expect(promptActionsNeedOwnRow({ ...metrics, textWidth: 273 })).toBe(true);
  });

  it("always gives an explicitly multiline prompt its own action row", () => {
    expect(promptActionsNeedOwnRow({ ...metrics, textWidth: 20, hasHardLineBreak: true })).toBe(true);
  });

  it("fails safely to the non-overlapping layout when measurement is unavailable", () => {
    expect(promptActionsNeedOwnRow({ ...metrics, textWidth: Number.NaN })).toBe(true);
  });
});
