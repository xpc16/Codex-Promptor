import type { TerminalTransportMode } from "../shared/terminal-protocol.js";

/** Local loopback gets the full byte stream; every remote address gets projection. */
export function resolveAutomaticTerminalTransport(hostname: string): TerminalTransportMode {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1"
    ? "raw"
    : "projection";
}
