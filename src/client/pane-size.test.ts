import { describe, expect, it } from "vitest";
import { clampPaneSize, CONSOLE_WIDTH, queueTerminalSplit, readPaneSize, workspaceSplit, writePaneSize, type PaneStore } from "./pane-size.js";

function fakeStore(initial: Record<string, string> = {}): PaneStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); } };
}

describe("browser-local pane sizes", () => {
  it("falls back to the shipped width until this browser has been resized", () => {
    expect(readPaneSize(CONSOLE_WIDTH, fakeStore())).toBe(300);
  });

  it("round-trips a width through this browser's own storage", () => {
    const store = fakeStore();
    writePaneSize(CONSOLE_WIDTH, 388, store);
    expect(readPaneSize(CONSOLE_WIDTH, store)).toBe(388);
  });

  it("clamps stored and incoming values to the draggable range", () => {
    const store = fakeStore({ [CONSOLE_WIDTH.key]: "9999" });
    expect(readPaneSize(CONSOLE_WIDTH, store)).toBe(520);
    writePaneSize(CONSOLE_WIDTH, 10, store);
    expect(readPaneSize(CONSOLE_WIDTH, store)).toBe(220);
    expect(clampPaneSize(Number.NaN, CONSOLE_WIDTH)).toBe(300);
  });

  it("ignores a corrupted entry instead of laying out at NaN", () => {
    expect(readPaneSize(CONSOLE_WIDTH, fakeStore({ [CONSOLE_WIDTH.key]: "wide-ish" }))).toBe(300);
  });

  it("keeps a separate split per conversation, seeded from the tab's stored layout", () => {
    const store = fakeStore();
    const first = workspaceSplit("tab-1", 42);
    const second = workspaceSplit("tab-2", 60);
    expect(first.key).not.toBe(second.key);
    expect(readPaneSize(second, store)).toBe(60);
    writePaneSize(first, 30, store);
    expect(readPaneSize(first, store)).toBe(30);
    expect(readPaneSize(second, store)).toBe(60);
  });

  it("keeps queue and terminal heights local to each browser and conversation", () => {
    const localStore = fakeStore();
    const remoteStore = fakeStore();
    const first = queueTerminalSplit("tab-1");
    const second = queueTerminalSplit("tab-2");

    writePaneSize(first, 67, remoteStore);

    expect(readPaneSize(first, remoteStore)).toBe(67);
    expect(readPaneSize(first, localStore)).toBe(54);
    expect(readPaneSize(second, remoteStore)).toBe(54);
  });

  it("degrades to the default when the browser denies storage", () => {
    const denied: PaneStore = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
    };
    expect(readPaneSize(CONSOLE_WIDTH, denied)).toBe(300);
    expect(() => writePaneSize(CONSOLE_WIDTH, 400, denied)).not.toThrow();
    expect(readPaneSize(CONSOLE_WIDTH, null)).toBe(300);
  });
});
