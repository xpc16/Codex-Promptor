/**
 * Which static responses may be cached for good.
 *
 * Vite names every chunk under `/assets/` after its content hash, so a URL
 * there can never point at different bytes: a rebuild that changes a file
 * changes its name, and `index.html` -- which is *not* hashed and keeps its
 * revalidate-every-time policy -- is what carries the new names.
 *
 * Measured before this existed: `@fastify/static` sent `max-age=0` with an
 * mtime-based weak ETag, and `npm run build` rewrites every file, so a byte-
 * identical `react-*.js` (60 KB compressed) and `xterm-*.js` (72 KB) were
 * downloaded again after each build. 73% of the tunnel's static bytes over
 * six days were vendor chunks that had not changed.
 */

/** `/assets/<name>-<8 url-safe base64 chars>.<ext>` -- Vite's default `[name]-[hash][extname]`. */
const HASHED_ASSET = /^\/assets\/[^/?#]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+$/;

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The Cache-Control a static response should carry, or null to leave the
 * plugin's own header alone.
 *
 * Only a hit (200 or 304) on a hashed asset qualifies. A 404 for a stale name
 * must not be cached for a year: the next build may well create it.
 */
export function immutableCacheControl(url: string, statusCode: number): string | null {
  if (statusCode !== 200 && statusCode !== 304) return null;
  const pathname = url.split(/[?#]/, 1)[0];
  return HASHED_ASSET.test(pathname) ? IMMUTABLE_CACHE_CONTROL : null;
}
