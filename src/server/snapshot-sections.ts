import type { TabBundle } from "../shared/schemas.js";
import { entityTag } from "./http-cache.js";

/**
 * A tab bundle, tagged one section at a time.
 *
 * A reconnecting page cannot know what it missed while it was away, so it asks
 * for the bundle -- and on a link that reconnects every couple of minutes that
 * was the largest thing crossing it after the terminal itself: 33% of
 * everything sent outbound in a measured 38-minute window.
 *
 * One hash over the whole bundle only helps when *nothing* moved. At the
 * window the server sends (24 prompts, 3 answers), prompts are around 72% of a
 * bundle, answers 23%, tab 3%, and runtime 2% -- a few hundred bytes. Runtime
 * is the section that moves on almost every event and the smallest one there
 * is, so a whole-bundle hash spends 24 kB to deliver half a kilobyte of runner
 * state. Per section, that case costs what it is worth.
 *
 * This is deliberately not a delta: one prompt queued still re-sends all 24 of
 * them. A record-level delta is a larger piece of work, and it would be
 * chasing the case this one already makes cheap.
 */

export const SNAPSHOT_SECTIONS = ["tab", "prompts", "answers", "runtime"] as const;

export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];
export type SnapshotTags = Record<SnapshotSection, string>;

/**
 * Content hashes rather than the in-memory sequence counter.
 *
 * `sequences` restarts at zero with the process, so a page that slept through
 * a restart could hold a number the server had climbed back to with entirely
 * different content behind it -- a false match, and a silently stale tab.
 */
export function snapshotTags(bundle: TabBundle): SnapshotTags {
  return {
    tab: entityTag(JSON.stringify(bundle.tab)),
    prompts: entityTag(JSON.stringify(bundle.prompts)),
    answers: entityTag(JSON.stringify(bundle.answers)),
    runtime: entityTag(JSON.stringify(bundle.runtime)),
  };
}

/**
 * What to send this page, or null when it already holds every section.
 *
 * `window` rides along with any section that moved: it is derived from the
 * prompt and answer counts, so it cannot be stale next to them, and at ~120
 * bytes it is not worth a tag of its own.
 *
 * Anything unrecognised in `held` -- absent, a string from an older page, a
 * shape from a newer one -- reads as "holds nothing", which sends the whole
 * bundle. That is what every page got before this existed.
 */
export function changedSnapshotSections(
  bundle: TabBundle,
  tags: SnapshotTags,
  held: unknown,
): Partial<TabBundle> | null {
  const claimed = held && typeof held === "object" ? held as Record<string, unknown> : {};
  const changed: Partial<TabBundle> = {};
  let moved = false;
  for (const section of SNAPSHOT_SECTIONS) {
    if (claimed[section] === tags[section]) continue;
    (changed as Record<string, unknown>)[section] = bundle[section];
    moved = true;
  }
  if (!moved) return null;
  if (bundle.window) changed.window = bundle.window;
  return changed;
}
