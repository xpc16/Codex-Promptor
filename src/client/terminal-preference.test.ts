import { describe, expect, it } from "vitest";
import { readTerminalTransportPreference, resolveTerminalTransportPreference, writeTerminalTransportPreference } from "./terminal-preference.js";

describe("terminal transport preference", () => {
  it("keeps local access raw and chooses projection for remote hosts in auto mode", () => {
    expect(resolveTerminalTransportPreference("auto", "127.0.0.1")).toBe("raw");
    expect(resolveTerminalTransportPreference("auto", "[::1]")).toBe("raw");
    expect(resolveTerminalTransportPreference("auto", "promptor.example.com")).toBe("projection");
    expect(resolveTerminalTransportPreference("raw", "promptor.example.com")).toBe("raw");
  });

  it("persists only known values and falls back safely", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
    writeTerminalTransportPreference("projection", storage);
    expect(readTerminalTransportPreference(storage)).toBe("projection");
    values.set("codex-promptor.terminal-transport", "unknown");
    expect(readTerminalTransportPreference(storage)).toBe("auto");
  });
});

