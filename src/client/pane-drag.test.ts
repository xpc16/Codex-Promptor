import { describe, expect, it, vi } from "vitest";
import { onPaneDragEnd, PaneDrag, paneDragActive } from "./pane-drag.js";

describe("pane drag", () => {
  it("moves the pane on every event but stores the size only once", () => {
    const write = vi.fn();
    const commit = vi.fn();
    const drag = new PaneDrag(54, write, commit);

    drag.move(58);
    drag.move(61);
    expect(write.mock.calls).toEqual([[58], [61]]);
    expect(commit).not.toHaveBeenCalled();

    drag.end();
    expect(commit.mock.calls).toEqual([[61]]);
  });

  it("survives a release arriving twice", () => {
    const commit = vi.fn();
    const drag = new PaneDrag(50, () => undefined, commit);

    drag.end();
    drag.end();

    expect(commit.mock.calls).toEqual([[50]]);
    expect(paneDragActive()).toBe(false);
  });

  it("ignores a move that arrives after the release", () => {
    const write = vi.fn();
    const drag = new PaneDrag(50, write, () => undefined);

    drag.end();
    drag.move(70);

    expect(write).not.toHaveBeenCalled();
  });

  it("reports a drag in flight and notifies once when the last one ends", () => {
    // The terminal stops resizing itself while this is true, so a count that
    // never came back down would strand it at its pre-drag size for good.
    const ended = vi.fn();
    const stop = onPaneDragEnd(ended);
    const first = new PaneDrag(10, () => undefined, () => undefined);
    const second = new PaneDrag(20, () => undefined, () => undefined);
    expect(paneDragActive()).toBe(true);

    first.end();
    expect(paneDragActive()).toBe(true);
    expect(ended).not.toHaveBeenCalled();

    second.end();
    expect(paneDragActive()).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);

    stop();
    new PaneDrag(30, () => undefined, () => undefined).end();
    expect(ended).toHaveBeenCalledTimes(1);
  });
});
