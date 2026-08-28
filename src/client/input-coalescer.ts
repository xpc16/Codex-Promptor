/**
 * Batching terminal keystrokes before they go up the socket.
 *
 * Measured over an hour: 3,682 inbound `terminal.input` messages, every one of
 * them 92 bytes, none compressed -- they are all far below the deflate
 * threshold, and the frame header and mask cost more than deflate would save.
 * One frame per character is the whole reason.
 *
 * Human keystrokes land 100-200ms apart, so a window well under that is not
 * perceptible: the character still reaches the agent within one frame time,
 * and what disappears is the per-frame overhead, not the responsiveness.
 *
 * What must never wait is anything that is a command rather than a character.
 * Enter submits, Escape cancels, Ctrl-C interrupts, an arrow key moves through
 * history -- delaying those is felt immediately. They are recognised by being
 * control bytes, which also covers the escape sequences that arrow keys,
 * function keys and bracketed-paste markers arrive as.
 */

export const INPUT_COALESCE_MS = 40;
export const INPUT_COALESCE_MAX_BYTES = 256;

const CONTROL_RE = /[\x00-\x1f\x7f]/;

/** Whether this chunk has to go now: it carries a command, not typed text. */
export function flushesImmediately(data: string): boolean {
  return CONTROL_RE.test(data);
}

export type InputCoalescer = {
  /** Queue one chunk of terminal input, sending immediately when it cannot wait. */
  push(data: string): void;
  /** Send whatever is buffered. Call before closing or switching connection. */
  flush(): void;
  dispose(): void;
};

export type InputCoalescerOptions = {
  windowMs?: number;
  maxBytes?: number;
  /** Injected so tests do not wait on real time. */
  schedule?: (run: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export function createInputCoalescer(send: (data: string) => void, options: InputCoalescerOptions = {}): InputCoalescer {
  const windowMs = Math.max(0, options.windowMs ?? INPUT_COALESCE_MS);
  const maxBytes = Math.max(1, options.maxBytes ?? INPUT_COALESCE_MAX_BYTES);
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let buffer = "";
  let timer: unknown = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    if (!buffer) return;
    const pending = buffer;
    buffer = "";
    send(pending);
  };

  return {
    push(data) {
      if (disposed || !data) return;
      // Appended before flushing rather than sent on its own: the buffered
      // characters were typed first, and a command that overtook them would
      // reach the agent in the wrong order.
      buffer += data;
      if (flushesImmediately(data) || buffer.length >= maxBytes || windowMs === 0) {
        flush();
        return;
      }
      if (timer === null) timer = schedule(() => { timer = null; flush(); }, windowMs);
    },
    flush,
    dispose() {
      disposed = true;
      clearTimer();
      buffer = "";
    },
  };
}
