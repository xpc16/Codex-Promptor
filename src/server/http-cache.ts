import { createHash } from "node:crypto";

/**
 * Conversation reads are served straight from the browser's own HTTP cache and
 * revalidated instead of re-downloaded. `no-cache` is not "do not store" -- it
 * stores the body and asks first, so an unchanged conversation costs a 304
 * header exchange rather than the answer text all over again.
 */
export const REVALIDATE_CACHE_CONTROL = "private, no-cache, max-age=0, must-revalidate";

/** Responses differ per access token, so the cache must be keyed by it. */
export const REVALIDATE_VARY = "x-codex-promptor-token, accept-encoding";

export function entityTag(body: string): string {
  return `"${createHash("sha1").update(body).digest("base64url")}"`;
}

/**
 * Whether the client's cached copy is still the one we would send.
 *
 * `If-None-Match` carries a comma-separated list, entries may be weak, and
 * `*` matches anything we hold. Content coding is negotiated after this check,
 * so a `-gzip` suffix added downstream by a proxy must still count as a match.
 */
export function ifNoneMatchSatisfied(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const wanted = normalizeTag(etag);
  for (const candidate of raw.split(",")) {
    const value = candidate.trim();
    if (!value) continue;
    if (value === "*") return true;
    if (normalizeTag(value) === wanted) return true;
  }
  return false;
}

/**
 * Whether a conditional write still targets the representation the caller
 * edited. The route distinguishes an absent header (428) from a stale value
 * (412); this helper intentionally answers only the matching question.
 */
export function ifMatchSatisfied(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  const current = normalizeTag(etag);
  for (const candidate of raw.split(",")) {
    const value = candidate.trim();
    if (!value) continue;
    if (value === "*") return true;
    if (normalizeTag(value) === current) return true;
  }
  return false;
}

function normalizeTag(value: string): string {
  const withoutWeakness = value.startsWith("W/") ? value.slice(2) : value;
  const unquoted = withoutWeakness.startsWith("\"") && withoutWeakness.endsWith("\"") && withoutWeakness.length >= 2
    ? withoutWeakness.slice(1, -1)
    : withoutWeakness;
  // @fastify/compress and some proxies append the coding to the tag.
  return unquoted.replace(/-(?:gzip|br|deflate|zstd)$/i, "");
}
