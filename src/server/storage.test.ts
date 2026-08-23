import { describe, expect, it, vi } from "vitest";
import { writeFileAtomicWithRetry } from "./storage.js";

describe("atomic JSON writes", () => {
  it("retries transient Windows rename failures", async () => {
    const writer = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }))
      .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
      .mockResolvedValue(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(writeFileAtomicWithRetry("runtime.json", "{}\n", writer, delay)).resolves.toBeUndefined();

    expect(writer).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenNthCalledWith(1, 40);
    expect(delay).toHaveBeenNthCalledWith(2, 80);
  });

  it("does not retry unrelated filesystem failures", async () => {
    const failure = Object.assign(new Error("disk error"), { code: "EIO" });
    const writer = vi.fn().mockRejectedValue(failure);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(writeFileAtomicWithRetry("runtime.json", "{}\n", writer, delay)).rejects.toBe(failure);
    expect(writer).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
