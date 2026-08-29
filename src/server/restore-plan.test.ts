import { describe, expect, it, vi } from "vitest";
import { restoreOrder, runRestoreQueue } from "./restore-plan.js";
import type { TabMeta } from "../shared/schemas.js";

const tab = (id: string, groupId: string | null, order: number): TabMeta => ({
  id,
  name: id,
  groupId,
  order,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  session: {
    provider: "codex", state: "ready", reopenOnLaunch: true, workingDirectory: "D:\\work",
    threadId: `thread-${id}`, sessionId: `thread-${id}`, createdAt: "2026-08-01T00:00:00.000Z",
    connectedAt: "2026-08-01T00:00:00.000Z", lastError: null, lastThreadSwitch: null,
  },
  layout: { leftWidthPercent: 50 },
} as TabMeta);

const tabs = [
  tab("a1", "alpha", 0),
  tab("a2", "alpha", 1),
  tab("b1", "beta", 2),
  tab("b2", "beta", 3),
  tab("loose", null, 4),
];

describe("restoreOrder", () => {
  it("brings back the conversation that was open, then the rest of its group", () => {
    const order = restoreOrder(tabs, ["a1", "a2", "b1", "b2", "loose"], "b1");
    expect(order).toEqual(["b1", "b2", "a1", "a2", "loose"]);
  });

  it("keeps the sidebar order inside each band", () => {
    // The order the reader can see is the order they can predict.
    expect(restoreOrder(tabs, ["loose", "b2", "a2", "a1"], "a2")).toEqual(["a2", "a1", "b2", "loose"]);
  });

  it("treats ungrouped conversations as a group of their own", () => {
    expect(restoreOrder(tabs, ["a1", "b1", "loose"], "loose")).toEqual(["loose", "a1", "b1"]);
  });

  it("falls back to sidebar order when the remembered tab is gone or was never stored", () => {
    expect(restoreOrder(tabs, ["b1", "a1"], null)).toEqual(["a1", "b1"]);
    expect(restoreOrder(tabs, ["b1", "a1"], "deleted")).toEqual(["a1", "b1"]);
  });

  it("still restores a candidate the index no longer lists", () => {
    // Dropping it here would silently stop restoring it, which is worse than
    // restoring it last.
    expect(restoreOrder(tabs, ["a1", "ghost"], "a1")).toEqual(["a1", "ghost"]);
  });
});

describe("runRestoreQueue", () => {
  /** The launcher hands off through a catch and a then, so one tick is not enough. */
  const flush = async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); };

  /** A task whose completion the test controls. */
  function gate() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }

  /** A stagger the test steps through by hand, so nothing waits on real time. */
  function stagger() {
    const requested: number[] = [];
    const pending: Array<() => void> = [];
    return {
      wait: (ms: number) => new Promise<void>((resolve) => { requested.push(ms); pending.push(resolve); }),
      ms: () => [...requested],
      async step() { pending.shift()?.(); await flush(); },
    };
  }

  it("never makes one restore wait for another to finish", async () => {
    // This is the regression being fixed: a restore is almost all waiting --
    // spawns, readiness polls, RPC round trips -- and capping how many may wait
    // at once turned parallel waiting into sequential waiting.
    const gates = new Map(["a", "b", "c"].map((id) => [id, gate()] as const));
    const started: string[] = [];
    const clock = stagger();
    const queue = runRestoreQueue(["a", "b", "c"], 250, async (id) => {
      started.push(id);
      await gates.get(id)!.promise;
    }, clock.wait);

    await flush();
    expect(started).toEqual(["a"]);
    await clock.step();
    expect(started).toEqual(["a", "b"]);
    await clock.step();
    expect(started).toEqual(["a", "b", "c"]);

    // All three were in flight together; none of them had finished.
    for (const entry of gates.values()) entry.release();
    await queue.done;
  });

  it("spaces the launches out instead of firing every spawn in one instant", async () => {
    const clock = stagger();
    const queue = runRestoreQueue(["a", "b", "c"], 250, async () => undefined, clock.wait);
    await flush();
    await clock.step();
    await clock.step();
    await queue.done;
    // Two gaps for three conversations: nothing waits after the last launch.
    expect(clock.ms()).toEqual([250, 250]);
  });

  it("moves a promoted conversation to the front of what has not launched", async () => {
    const started: string[] = [];
    const clock = stagger();
    const queue = runRestoreQueue(["a", "b", "c", "d"], 250, async (id) => { started.push(id); }, clock.wait);

    await flush();
    expect(started).toEqual(["a"]);

    // The page that just opened asked for "d"; it must not wait behind b and c.
    queue.promote("d");
    await clock.step();
    expect(started).toEqual(["a", "d"]);

    await clock.step();
    await clock.step();
    await queue.done;
    expect(started).toEqual(["a", "d", "b", "c"]);
  });

  it("ignores promoting something already launched or unknown", async () => {
    const queue = runRestoreQueue(["a", "b"], 0, async () => undefined);
    queue.promote("a");
    queue.promote("nothing");
    await expect(queue.done).resolves.toBeUndefined();
  });

  it("finishes even when a restore fails, and resolves an empty plan at once", async () => {
    // One conversation that cannot come back must not strand the others.
    const run = vi.fn().mockRejectedValue(new Error("TERMINAL_REOPEN_FAILED"));
    await expect(runRestoreQueue(["a", "b"], 0, run).done).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
    await expect(runRestoreQueue([], 0, run).done).resolves.toBeUndefined();
  });
});
