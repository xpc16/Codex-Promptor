/**
 * Pane dividers, driven by the DOM rather than by React.
 *
 * A divider drag delivers one pointer event per frame. Routing each of them
 * through setState re-rendered the whole subtree that owns the divider, and for
 * the dividers that bound the terminal that became an xterm resize per frame --
 * the DOM renderer rebuilds every visible row on a resize -- followed, once the
 * burst stopped, by a real ConPTY resize, which makes a TUI repaint its entire
 * screen.
 *
 * So the live size is written straight to the element it sizes and is persisted
 * once, when the gesture ends. React never sees the intermediate values, which
 * is also why nothing may re-apply the size from props: a stray render during
 * the drag would put the stale size back.
 */

/** Gestures in flight. A pointer drag is browser-wide, so one counter covers the page. */
let activeDrags = 0;
const endListeners = new Set<() => void>();

/** Whether a divider is being dragged right now, anywhere on the page. */
export function paneDragActive(): boolean {
  return activeDrags > 0;
}

/**
 * Runs when the last divider in flight is released, so work deferred for the
 * duration of a gesture happens once, at the size the reader stopped at.
 */
export function onPaneDragEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => { endListeners.delete(listener); };
}

/** One divider gesture, from pointerdown to release. */
export class PaneDrag {
  private value: number;
  private done = false;

  constructor(
    start: number,
    private readonly write: (value: number) => void,
    private readonly commit: (value: number) => void,
  ) {
    this.value = start;
    activeDrags += 1;
  }

  /** The pane follows the pointer immediately; nothing is stored yet. */
  move(value: number): void {
    if (this.done) return;
    this.value = value;
    this.write(value);
  }

  /**
   * Idempotent, because pointerup and pointercancel both arrive for a cancelled
   * drag and a view torn down mid-gesture has to end its own. A leaked count
   * would leave the page believing a drag is in flight for good, and everything
   * waiting on onPaneDragEnd would stall with it.
   */
  end(): void {
    if (this.done) return;
    this.done = true;
    activeDrags = Math.max(0, activeDrags - 1);
    this.commit(this.value);
    if (activeDrags === 0) for (const listener of [...endListeners]) listener();
  }
}
