export type DocumentTargetKind = "local-file" | "external" | "fragment" | "blocked" | "unknown";

export type DocumentTarget = {
  kind: DocumentTargetKind;
  rawHref: string;
  path: string | null;
  fragment: string | null;
  displayName: string | null;
};

const WINDOWS_ABSOLUTE_RE = /^[a-z]:[\\/]/i;
const INTERNAL_WINDOWS_ABSOLUTE_RE = /^\/[a-z]:[\\/]/i;
const DANGEROUS_PROTOCOL_RE = /^(?:javascript|data|vbscript):/i;
const EXTERNAL_PROTOCOL_RE = /^(?:https?|mailto|tel):/i;
const UNKNOWN_PROTOCOL_RE = /^[a-z][a-z0-9+.-]*:/i;

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function extractDocumentTarget(value: unknown): DocumentTarget {
  const rawHref = typeof value === "string" ? value.trim() : "";
  if (!rawHref) return target("unknown", rawHref);
  if (rawHref.startsWith("#")) return target("fragment", rawHref, null, rawHref.slice(1) || null);
  if (DANGEROUS_PROTOCOL_RE.test(rawHref)) return target("blocked", rawHref);
  if (EXTERNAL_PROTOCOL_RE.test(rawHref)) return target("external", rawHref);

  if (/^file:/i.test(rawHref)) {
    try {
      const url = new URL(rawHref);
      if (url.protocol !== "file:" || url.search) return target("blocked", rawHref);
      const pathname = safeDecode(url.pathname);
      if (pathname === null) return target("blocked", rawHref);
      const path = /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
      return target("local-file", rawHref, path, decodeFragment(url.hash));
    } catch {
      return target("blocked", rawHref);
    }
  }

  const { pathPart, fragment } = splitFragment(rawHref);
  if (WINDOWS_ABSOLUTE_RE.test(pathPart)) return target("local-file", rawHref, pathPart, fragment);
  if (INTERNAL_WINDOWS_ABSOLUTE_RE.test(pathPart)) return target("local-file", rawHref, pathPart.slice(1), fragment);
  if (pathPart.startsWith("./") || pathPart.startsWith("../") || pathPart.startsWith(".\\") || pathPart.startsWith("..\\")) {
    return target("local-file", rawHref, pathPart, fragment);
  }
  if (UNKNOWN_PROTOCOL_RE.test(rawHref)) return target("unknown", rawHref);
  return target("unknown", rawHref);
}

/**
 * rehype-sanitize treats a Windows drive letter as a URL protocol. Convert only
 * link destinations that are already known local files to a real file URI;
 * images and unknown URLs must retain react-markdown's normal protections.
 */
export function normalizeDocumentHrefForMarkdown(value: string): string {
  const targetValue = extractDocumentTarget(value);
  if (targetValue.kind !== "local-file" || !targetValue.path) return value;
  if (/^file:/i.test(value)) return value;
  if (!WINDOWS_ABSOLUTE_RE.test(targetValue.path)) return value;
  const normalized = targetValue.path.replace(/\\/g, "/");
  const drive = normalized.slice(0, 2);
  const encodedPath = normalized.slice(3).split("/").map(encodeURIComponent).join("/");
  const fragment = targetValue.fragment ? `#${encodeURIComponent(targetValue.fragment)}` : "";
  return `file:///${drive}/${encodedPath}${fragment}`;
}

function target(kind: DocumentTargetKind, rawHref: string, path: string | null = null, fragment: string | null = null): DocumentTarget {
  return { kind, rawHref, path, fragment, displayName: displayName(path) };
}

function splitFragment(value: string): { pathPart: string; fragment: string | null } {
  const index = value.indexOf("#");
  if (index < 0) return { pathPart: value, fragment: null };
  return { pathPart: value.slice(0, index), fragment: safeDecode(value.slice(index + 1)) };
}

function decodeFragment(hash: string): string | null {
  if (!hash) return null;
  return safeDecode(hash.startsWith("#") ? hash.slice(1) : hash);
}

function safeDecode(value: string): string | null {
  try { return decodeURIComponent(value); }
  catch { return null; }
}

function displayName(value: string | null): string | null {
  if (!value) return null;
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? null;
}
