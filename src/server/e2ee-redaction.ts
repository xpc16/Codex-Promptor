import type { NetworkScope } from "./traffic-scope.js";

/**
 * Taking the encryption passphrase back out of anything bound for another
 * machine.
 *
 * The passphrase lives in a p2p tab's `workingDirectory`, which is a field of
 * `TabMeta` -- and `TabMeta` travels: in `index.changed`, in `tab.changed`, in
 * every subscribe snapshot, in `/api/bootstrap`, in `/api/tabs/:tabId`. Over
 * six measured days the tunnel received 206 index broadcasts and 198 snapshots.
 * Left alone, the passphrase would go out on the first of them.
 *
 * This walks the value rather than knowing the shapes it can take. Enumerating
 * them -- tab, index, index delta, bundle, bootstrap, each page endpoint -- is
 * a list that has to stay complete, and the failure of an incomplete list is a
 * secret on the wire with no error anywhere. A walk that recognises the tab
 * itself covers the shapes that exist now and the ones added later.
 *
 * It is not free, so it runs only for connections that are not loopback. That
 * is where it is needed and it is also the quiet side: 13,693 outbound
 * messages over those six days against 421,000 on loopback.
 */

/** Deep enough for a bundle inside a snapshot inside an envelope, and no deeper. */
const MAX_DEPTH = 12;

function isE2eeSession(value: Record<string, unknown>): boolean {
  return value.provider === "e2ee" && "workingDirectory" in value;
}

/**
 * The same reference when nothing was found, a copy only along the path to
 * what was. Most outbound messages carry no tab at all, and the ones that do
 * usually carry no encryption tab; neither should pay for a clone.
 */
function walk(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const walked = walk(entry, depth + 1);
      if (walked !== entry) changed = true;
      return walked;
    });
    return changed ? next : value;
  }

  const record = value as Record<string, unknown>;
  if (isE2eeSession(record)) {
    // Null rather than removed: the far end must still see that this tab
    // exists, or it cannot know encryption is on or show its state. What it
    // does not need is what was typed into it.
    return record.workingDirectory === null ? record : { ...record, workingDirectory: null };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    const walked = walk(entry, depth + 1);
    if (walked !== entry) changed = true;
    next[key] = walked;
  }
  return changed ? next : value;
}

export function redactForRemote<T>(value: T): T {
  return walk(value, 0) as T;
}

/** Loopback holds the passphrase already; it is where the reader typed it. */
export function redactForScope<T>(value: T, scope: NetworkScope): T {
  return scope === "local" ? value : redactForRemote(value);
}
