import type { TerminalTransportMode, TerminalTransportPreference } from "../shared/terminal-protocol.js";

const STORAGE_KEY = "codex-promptor.terminal-transport";

export function readTerminalTransportPreference(storage: Pick<Storage, "getItem"> = localStorage): TerminalTransportPreference {
  try {
    const value = storage.getItem(STORAGE_KEY);
    return value === "raw" || value === "projection" || value === "auto" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function writeTerminalTransportPreference(value: TerminalTransportPreference, storage: Pick<Storage, "setItem"> = localStorage): void {
  try { storage.setItem(STORAGE_KEY, value); } catch { /* private mode/quota */ }
}

export function resolveTerminalTransportPreference(value: TerminalTransportPreference, hostname: string): TerminalTransportMode {
  if (value !== "auto") return value;
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
    ? "raw"
    : "projection";
}

