import { describe, expect, it } from "vitest";
import { resolveAutomaticTerminalTransport } from "./terminal-preference.js";

describe("automatic terminal transport", () => {
  it("keeps loopback raw and chooses projection for every remote host", () => {
    expect(resolveAutomaticTerminalTransport("localhost")).toBe("raw");
    expect(resolveAutomaticTerminalTransport("127.0.0.1")).toBe("raw");
    expect(resolveAutomaticTerminalTransport("[::1]")).toBe("raw");
    expect(resolveAutomaticTerminalTransport("promptor.example.com")).toBe("projection");
    expect(resolveAutomaticTerminalTransport("192.168.1.20")).toBe("projection");
  });
});
