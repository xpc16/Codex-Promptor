import { describe, expect, it, vi } from "vitest";
import { waitForThreadLoaded } from "./codex.js";

describe("remote TUI attach", () => {
  it("waits until the TUI has loaded the thread before returning", async () => {
    const readThread = vi.fn()
      .mockResolvedValueOnce({ thread: { id: "thread-1", status: { type: "notLoaded" } } })
      .mockResolvedValueOnce({ thread: { id: "thread-1", status: { type: "idle" } } });

    await expect(waitForThreadLoaded({ readThread } as any, "thread-1", 1_000, 0)).resolves.toMatchObject({
      id: "thread-1",
      status: { type: "idle" },
    });
    expect(readThread).toHaveBeenCalledTimes(2);
  });

  it("accepts a genuinely active restored thread", async () => {
    const readThread = vi.fn().mockResolvedValue({ thread: { id: "thread-2", status: { type: "active", activeFlags: ["turn"] } } });
    await expect(waitForThreadLoaded({ readThread } as any, "thread-2", 1_000, 0)).resolves.toMatchObject({ status: { type: "active" } });
  });
});
