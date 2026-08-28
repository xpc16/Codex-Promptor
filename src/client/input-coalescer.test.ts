import { describe, expect, it } from "vitest";
import { createInputCoalescer, flushesImmediately, INPUT_COALESCE_MAX_BYTES } from "./input-coalescer.js";

/** A schedule the test drives by hand, so nothing waits on real time. */
function manualClock() {
  let pending: (() => void) | null = null;
  return {
    schedule: (run: () => void) => { pending = run; return 1; },
    cancel: () => { pending = null; },
    tick: () => { const run = pending; pending = null; run?.(); },
    get armed() { return pending !== null; },
  };
}

function coalescer(options: Partial<Parameters<typeof createInputCoalescer>[1]> = {}) {
  const sent: string[] = [];
  const clock = manualClock();
  const unit = createInputCoalescer((data) => sent.push(data), { schedule: clock.schedule, cancel: clock.cancel, ...options });
  return { sent, clock, unit };
}

describe("terminal input coalescing", () => {
  it("sends typed characters as one frame instead of one each", () => {
    const { sent, clock, unit } = coalescer();
    for (const character of "hello") unit.push(character);

    expect(sent).toEqual([]);
    clock.tick();
    expect(sent).toEqual(["hello"]);
  });

  it("does not make a command wait behind buffered text", () => {
    const { sent, clock, unit } = coalescer();
    unit.push("l");
    unit.push("s");
    unit.push("\r");

    // Enter goes now, and the two characters typed before it go with it --
    // sending the Enter on its own would reach the agent out of order.
    expect(sent).toEqual(["ls\r"]);
    expect(clock.armed).toBe(false);
  });

  it("treats every control byte as a command", () => {
    expect(flushesImmediately("a")).toBe(false);
    expect(flushesImmediately("中")).toBe(false);
    expect(flushesImmediately("\r")).toBe(true);   // Enter
    expect(flushesImmediately("\x1b")).toBe(true); // Escape
    expect(flushesImmediately("\x1b[A")).toBe(true); // 方向键
    expect(flushesImmediately("\x03")).toBe(true); // Ctrl-C
    expect(flushesImmediately("\x1b[200~")).toBe(true); // 粘贴边界
    expect(flushesImmediately("\x7f")).toBe(true); // Backspace
  });

  it("stops buffering once the batch is large enough to be worth sending", () => {
    const { sent, unit } = coalescer();
    unit.push("x".repeat(INPUT_COALESCE_MAX_BYTES - 1));
    expect(sent).toEqual([]);
    unit.push("y");
    expect(sent).toEqual([`${"x".repeat(INPUT_COALESCE_MAX_BYTES - 1)}y`]);
  });

  it("sends what is buffered when the connection is going away", () => {
    const { sent, unit } = coalescer();
    unit.push("half typed");
    unit.flush();
    expect(sent).toEqual(["half typed"]);
  });

  it("drops nothing and sends nothing after disposal", () => {
    const { sent, clock, unit } = coalescer();
    unit.push("abc");
    unit.dispose();
    clock.tick();
    unit.push("more");
    expect(sent).toEqual([]);
  });

  it("sends straight through when batching is switched off", () => {
    const { sent, unit } = coalescer({ windowMs: 0 });
    unit.push("a");
    unit.push("b");
    expect(sent).toEqual(["a", "b"]);
  });
});
