import { describe, expect, it } from "vitest";
import { classifyNetworkScope, hostname, isLoopbackAddress, isLoopbackHostname } from "./traffic-scope.js";

describe("network scope", () => {
  it("decides remote from the socket, which a client cannot forge", () => {
    // Host says whatever the client wants; the peer address is the truth.
    expect(classifyNetworkScope("203.0.113.9", "127.0.0.1:4317")).toBe("remote");
    expect(classifyNetworkScope("192.168.1.20", "localhost")).toBe("remote");
  });

  it("separates the local browser from a relay running on the same machine", () => {
    // cloudflared and an SSH forward both reach the origin from loopback, so
    // the socket alone cannot tell them from the local page. The Host it was
    // asked for can -- and that is the whole reason this split exists.
    expect(classifyNetworkScope("127.0.0.1", "127.0.0.1:4317")).toBe("local");
    expect(classifyNetworkScope("::1", "localhost:4317")).toBe("local");
    expect(classifyNetworkScope("127.0.0.1", "promptor.example.com")).toBe("tunnel");
    expect(classifyNetworkScope("::ffff:127.0.0.1", "abc.trycloudflare.com")).toBe("tunnel");
  });

  it("treats an unknown peer as remote rather than assuming it is safe", () => {
    expect(classifyNetworkScope(undefined, "localhost")).toBe("remote");
    expect(classifyNetworkScope("", "localhost")).toBe("remote");
  });

  it("reads the host without its port", () => {
    expect(hostname("promptor.example.com:8443")).toBe("promptor.example.com");
    expect(hostname("127.0.0.1:4317")).toBe("127.0.0.1");
    expect(hostname("[::1]:4317")).toBe("::1");
    expect(hostname(undefined)).toBe("");
  });

  it("recognises every loopback form node reports", () => {
    for (const address of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(address)).toBe(true);
    }
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackHostname("localhost:4317")).toBe(true);
    expect(isLoopbackHostname("example.com")).toBe(false);
  });
});
