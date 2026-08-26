import { describe, expect, it, vi } from "vitest";
import { isRetryableTabLoadError, loadTabWithRetry, retainRecentTabIds } from "./tab-load.js";

describe("conversation tab loading", () => {
  it("retries transient failures and returns the recovered bundle", async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("temporary read failure"), { retryable: true }))
      .mockResolvedValue({ id: "tab-2" });
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(loadTabWithRetry(load, { delays: [25], wait })).resolves.toEqual({ id: "tab-2" });
    expect(load).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(25);
  });

  it("does not retry a permanent API response", async () => {
    const error = Object.assign(new Error("missing tab"), { retryable: false });
    const load = vi.fn().mockRejectedValue(error);
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(loadTabWithRetry(load, { delays: [10, 20], wait })).rejects.toBe(error);
    expect(load).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
    expect(isRetryableTabLoadError(error)).toBe(false);
  });

  it("treats network errors without API metadata as retryable", () => {
    expect(isRetryableTabLoadError(new TypeError("fetch failed"))).toBe(true);
  });

  it("keeps only the active and most recently visited conversation views", () => {
    const valid = new Set(["find", "chat", "garden", "network"]);

    expect(retainRecentTabIds(["find", "chat"], "garden", valid)).toEqual(["chat", "garden"]);
    expect(retainRecentTabIds(["chat", "garden"], "network", valid)).toEqual(["garden", "network"]);
    expect(retainRecentTabIds(["removed", "network"], "network", valid)).toEqual(["network"]);
  });
});
