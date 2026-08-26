import { afterEach, describe, expect, it, vi } from "vitest";
import { UiLifecycle } from "./ui-lifecycle.js";

describe("UI lifecycle", () => {
  afterEach(() => vi.useRealTimers());

  it("uses a 30 second default grace period", () => {
    vi.useFakeTimers();
    const lifecycle = new UiLifecycle();
    const idle = vi.fn();
    lifecycle.on("idle", idle);

    lifecycle.connect();
    lifecycle.disconnect();
    vi.advanceTimersByTime(29_999);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("emits idle after the last connected page closes", () => {
    vi.useFakeTimers();
    const lifecycle = new UiLifecycle(5_000);
    const idle = vi.fn();
    lifecycle.on("idle", idle);

    lifecycle.connect();
    lifecycle.connect();
    lifecycle.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(idle).not.toHaveBeenCalled();

    lifecycle.disconnect();
    vi.advanceTimersByTime(4_999);
    expect(idle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(idle).toHaveBeenCalledOnce();
  });

  it("cancels shutdown when a refreshed page reconnects during the grace period", () => {
    vi.useFakeTimers();
    const lifecycle = new UiLifecycle(5_000);
    const idle = vi.fn();
    lifecycle.on("idle", idle);

    lifecycle.connect();
    lifecycle.disconnect();
    vi.advanceTimersByTime(2_000);
    lifecycle.connect();
    vi.advanceTimersByTime(10_000);

    expect(lifecycle.clientCount).toBe(1);
    expect(idle).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it("does not arm until a page has connected", () => {
    vi.useFakeTimers();
    const lifecycle = new UiLifecycle(1);
    const idle = vi.fn();
    lifecycle.on("idle", idle);

    lifecycle.disconnect();
    vi.runAllTimers();
    expect(idle).not.toHaveBeenCalled();
  });
});
