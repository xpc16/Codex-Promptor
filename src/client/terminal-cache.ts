import type { ProjectionScreenState } from "./terminal-projection.js";

/**
 * What this browser has already been told about a terminal.
 *
 * Only two conversation views stay mounted, so switching away disposes the
 * xterm instance and the cursor that went with it. Reconnecting without a
 * cursor makes the server resend the session's entire scroll buffer -- up to a
 * megabyte -- every single time the reader comes back to the tab, which over a
 * tunnel is by far the largest repeated transfer in the app.
 *
 * Holding the bytes and the cursor here turns that into: repaint locally from
 * what we already have, then ask the server only for what arrived while we
 * were away, which is usually nothing.
 */
export const MAX_CACHED_TERMINAL_BYTES = 256 * 1024;
export const MAX_CACHED_TERMINALS = 4;

export type RawTerminalMemory = { generation: string; nextOffset: number; data: Uint8Array };

type RawEntry = { generation: string; nextOffset: number; chunks: Uint8Array[]; bytes: number };
type Entry = { raw: RawEntry | null; projection: ProjectionScreenState | null };

export type TerminalCache = {
  readRaw(tabId: string): RawTerminalMemory | null;
  rememberRaw(tabId: string, generation: string, nextOffset: number, fresh: Uint8Array, reset: boolean): void;
  readProjection(tabId: string): ProjectionScreenState | null;
  rememberProjection(tabId: string, state: ProjectionScreenState): void;
  forget(tabId: string): void;
  retain(validIds: ReadonlySet<string>): void;
  size(): number;
};

export function createTerminalCache(
  limit = MAX_CACHED_TERMINALS,
  byteLimit = MAX_CACHED_TERMINAL_BYTES,
): TerminalCache {
  const entries = new Map<string, Entry>();

  const touch = (tabId: string): Entry => {
    const existing = entries.get(tabId) ?? { raw: null, projection: null };
    entries.delete(tabId);
    entries.set(tabId, existing);
    while (entries.size > Math.max(1, limit)) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
    return existing;
  };

  return {
    readRaw(tabId) {
      const raw = entries.get(tabId)?.raw;
      if (!raw || raw.bytes === 0) return null;
      const data = new Uint8Array(raw.bytes);
      let offset = 0;
      for (const chunk of raw.chunks) { data.set(chunk, offset); offset += chunk.length; }
      return { generation: raw.generation, nextOffset: raw.nextOffset, data };
    },

    rememberRaw(tabId, generation, nextOffset, fresh, reset) {
      const entry = touch(tabId);
      if (reset || !entry.raw || entry.raw.generation !== generation) {
        entry.raw = { generation, nextOffset, chunks: [], bytes: 0 };
      }
      const raw = entry.raw;
      raw.nextOffset = nextOffset;
      if (fresh.length === 0) return;
      raw.chunks.push(fresh.slice());
      raw.bytes += fresh.length;
      // Drop whole chunks rather than slicing one: the server trims its own
      // buffer at arbitrary byte boundaries too, and an escape sequence cut in
      // half repaints wrong. Chunk edges are no worse than any other cut, and
      // this keeps the retained bytes aligned with what was actually received.
      while (raw.bytes > byteLimit && raw.chunks.length > 1) {
        const dropped = raw.chunks.shift();
        raw.bytes -= dropped?.length ?? 0;
      }
    },

    readProjection(tabId) { return entries.get(tabId)?.projection ?? null; },
    rememberProjection(tabId, state) { touch(tabId).projection = state; },
    forget(tabId) { entries.delete(tabId); },
    retain(validIds) {
      for (const tabId of [...entries.keys()]) if (!validIds.has(tabId)) entries.delete(tabId);
    },
    size() { return entries.size; },
  };
}

const pageTerminals = createTerminalCache();

export function readCachedRawTerminal(tabId: string, cache: TerminalCache = pageTerminals): RawTerminalMemory | null {
  return cache.readRaw(tabId);
}
export function rememberRawTerminal(tabId: string, generation: string, nextOffset: number, fresh: Uint8Array, reset: boolean, cache: TerminalCache = pageTerminals): void {
  cache.rememberRaw(tabId, generation, nextOffset, fresh, reset);
}
export function readCachedProjection(tabId: string, cache: TerminalCache = pageTerminals): ProjectionScreenState | null {
  return cache.readProjection(tabId);
}
export function rememberProjection(tabId: string, state: ProjectionScreenState, cache: TerminalCache = pageTerminals): void {
  cache.rememberProjection(tabId, state);
}
export function forgetCachedTerminal(tabId: string, cache: TerminalCache = pageTerminals): void { cache.forget(tabId); }
export function retainCachedTerminals(validIds: ReadonlySet<string>, cache: TerminalCache = pageTerminals): void { cache.retain(validIds); }
