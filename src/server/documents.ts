import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractDocumentTarget, isLoopbackHostname, splitLineAnchor } from "../shared/document-link.js";
import {
  DOCUMENT_HREF_MAX_BYTES,
  DOCUMENT_ID_RE,
  DOCUMENT_MEMO_MAX_ENTRIES,
  DOCUMENT_REMOTE_MAX_BYTES,
  DOCUMENT_REVISION_RE,
  documentChunkRange,
  type DocumentKind,
  type DocumentOpenMetadata,
  type DocumentOpenRequest,
} from "../shared/document-protocol.js";
import type { StorageService } from "./storage.js";

const ACTIVE_EXTENSIONS = new Set([
  ".exe", ".com", ".bat", ".cmd", ".ps1", ".msi", ".reg", ".lnk", ".url",
  ".js", ".jse", ".vbs", ".vbe", ".wsf", ".wsh", ".scr", ".hta",
]);
const REMOTE_KINDS = new Map<string, DocumentKind>([
  [".txt", "text"], [".text", "text"], [".md", "markdown"], [".markdown", "markdown"],
]);
const CONFIRMATION_TTL_MS = 2 * 60 * 1_000;

export type DocumentChunk = {
  bytes: Buffer;
  docId: string;
  revision: string;
  index: number;
  name: string;
  kind: DocumentKind;
};

export type DocumentLocalResult = { name: string; opened: true };

export type DocumentServiceOptions = {
  configuredRoots?: string[];
  openWithDefaultApplication?: (absolutePath: string) => Promise<void>;
  now?: () => number;
};

type DocumentMemo = {
  docId: string;
  canonicalPath: string;
  name: string;
  kind: DocumentKind;
  size: number;
  revision: string;
  authorizedRoots: Set<string>;
  authorizedTabIds: Set<string>;
};

type AuthorizedFile = {
  canonicalPath: string;
  name: string;
  stat: Awaited<ReturnType<Awaited<ReturnType<typeof fs.open>>["stat"]>>;
  roots: string[];
};

export class DocumentError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DocumentError";
  }
}

export class DocumentService {
  readonly privateDir: string;
  private readonly memo = new Map<string, DocumentMemo>();
  private readonly configuredRoots: string[];

  private constructor(
    readonly rootDir: string,
    private readonly storage: StorageService,
    private readonly key: Buffer,
    configuredRoots: string[],
    private readonly opener: (absolutePath: string) => Promise<void>,
    private readonly now: () => number,
  ) {
    this.privateDir = path.join(rootDir, "data", "private");
    this.configuredRoots = configuredRoots;
  }

  static async create(rootDir: string, storage: StorageService, options: DocumentServiceOptions = {}): Promise<DocumentService> {
    const absoluteRoot = path.resolve(rootDir);
    const privateDir = path.join(absoluteRoot, "data", "private");
    const key = await readOrCreateDocumentKey(privateDir);
    const configured = options.configuredRoots ?? (process.env.CODEX_PROMPTOR_DOCUMENT_ROOTS ?? "")
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean);
    const configuredRoots = await canonicalExistingDirectories(configured);
    return new DocumentService(
      absoluteRoot,
      storage,
      key,
      configuredRoots,
      options.openWithDefaultApplication ?? openWithWindowsDefaultApplication,
      options.now ?? Date.now,
    );
  }

  async open(request: DocumentOpenRequest): Promise<DocumentOpenMetadata> {
    const authorized = await this.resolveAuthorizedFile(request);
    const kind = REMOTE_KINDS.get(path.extname(authorized.name).toLowerCase());
    if (!kind) throw documentError(415, "DOCUMENT_REMOTE_FORMAT_UNSUPPORTED", "Remote preview supports UTF-8 TXT and Markdown files only.", authorized.name);
    if (Number(authorized.stat.size) > DOCUMENT_REMOTE_MAX_BYTES) {
      throw documentError(413, "DOCUMENT_TOO_LARGE", "The document is too large for remote preview.", authorized.name);
    }
    await assertSupportedBom(authorized.canonicalPath, authorized.name);

    const docId = this.documentId(authorized.canonicalPath);
    const revision = this.revision(docId, authorized.stat);
    const existing = this.memo.get(docId);
    if (existing && existing.canonicalPath !== authorized.canonicalPath) {
      throw new DocumentError(500, "DOCUMENT_CHUNK_FAILED", "The document identifier collided with another path.");
    }
    const entry: DocumentMemo = existing ?? {
      docId,
      canonicalPath: authorized.canonicalPath,
      name: authorized.name,
      kind,
      size: Number(authorized.stat.size),
      revision,
      authorizedRoots: new Set(),
      authorizedTabIds: new Set(),
    };
    entry.name = authorized.name;
    entry.kind = kind;
    entry.size = Number(authorized.stat.size);
    entry.revision = revision;
    entry.authorizedTabIds.add(request.tabId);
    for (const root of authorized.roots) entry.authorizedRoots.add(root);
    this.touchMemo(entry);
    return { docId, name: entry.name, kind, size: entry.size, revision, encoding: "utf-8" };
  }

  async openLocal(request: DocumentOpenRequest & { confirmationToken?: string }): Promise<DocumentLocalResult> {
    const authorized = await this.resolveAuthorizedFile(request);
    const docId = this.documentId(authorized.canonicalPath);
    const revision = this.revision(docId, authorized.stat);
    const extension = path.extname(authorized.name).toLowerCase();
    if (ACTIVE_EXTENSIONS.has(extension)) {
      const token = String(request.confirmationToken ?? "");
      if (!token || !this.validConfirmationToken(token, authorized.canonicalPath, revision)) {
        throw new DocumentError(409, "DOCUMENT_CONFIRMATION_REQUIRED", "This file type can execute code and requires confirmation.", {
          name: authorized.name,
          fileType: extension || "executable",
          confirmationToken: this.confirmationToken(authorized.canonicalPath, revision),
        });
      }
    }
    try {
      await this.opener(authorized.canonicalPath);
    } catch {
      throw documentError(500, "DOCUMENT_OPEN_FAILED", "Windows could not hand the file to its default application.", authorized.name);
    }
    return { name: authorized.name, opened: true };
  }

  async readChunk(docId: string, revision: string, index: number): Promise<DocumentChunk> {
    if (!DOCUMENT_ID_RE.test(docId)) throw new DocumentError(400, "DOCUMENT_ID_UNKNOWN", "The document identifier is invalid.");
    if (!DOCUMENT_REVISION_RE.test(revision)) throw new DocumentError(400, "DOCUMENT_CHANGED", "The document revision is invalid.");
    if (!Number.isSafeInteger(index) || index < 0) throw new DocumentError(400, "DOCUMENT_CHUNK_OUT_OF_RANGE", "The document chunk index is invalid.");
    const memo = this.memo.get(docId);
    if (!memo) throw new DocumentError(404, "DOCUMENT_ID_UNKNOWN", "The document must be opened again.");
    this.touchMemo(memo);

    let canonicalPath: string;
    try { canonicalPath = await fs.realpath(memo.canonicalPath); }
    catch (error) { throw fileSystemDocumentError(error, memo.name); }
    if (!samePath(canonicalPath, memo.canonicalPath)) throw documentError(403, "DOCUMENT_ACCESS_DENIED", "The document target is no longer authorized.", memo.name);

    const roots = await canonicalExistingDirectories([...memo.authorizedRoots]);
    if (!roots.some((root) => containsPath(root, canonicalPath))) {
      throw documentError(403, "DOCUMENT_ACCESS_DENIED", "The document is outside the allowed directories.", memo.name);
    }

    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(canonicalPath, "r");
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw documentError(400, "DOCUMENT_IS_DIRECTORY", "The document target is not a regular file.", memo.name);
      const currentRevision = this.revision(docId, before);
      if (currentRevision !== revision || currentRevision !== memo.revision) throw documentError(409, "DOCUMENT_CHANGED", "The document changed while it was open.", memo.name);
      const size = Number(before.size);
      if (size > DOCUMENT_REMOTE_MAX_BYTES) throw documentError(413, "DOCUMENT_TOO_LARGE", "The document is too large for remote preview.", memo.name);
      const range = documentChunkRange(size, index);
      if (!range) throw documentError(416, "DOCUMENT_CHUNK_OUT_OF_RANGE", "The document chunk index is outside the file.", memo.name);

      const bytes = Buffer.allocUnsafe(range.length);
      let offset = 0;
      while (offset < range.length) {
        const result = await handle.read(bytes, offset, range.length - offset, range.start + offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (offset !== range.length || this.revision(docId, after) !== revision) {
        throw documentError(409, "DOCUMENT_CHANGED", "The document changed while the chunk was read.", memo.name);
      }
      return { bytes, docId, revision, index, name: memo.name, kind: memo.kind };
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      throw fileSystemDocumentError(error, memo.name, "DOCUMENT_CHUNK_FAILED");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async resolveAuthorizedFile(request: DocumentOpenRequest): Promise<AuthorizedFile> {
    assertOpenRequest(request);
    const target = extractDocumentTarget(request.href);
    if (target.kind !== "local-file") throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The link is not a local document path.");
    const parsed = parseLocalHref(request.href);
    const bundle = await this.storage.readTab(request.tabId).catch(() => null);
    if (!bundle) throw new DocumentError(404, "DOCUMENT_TAB_UNKNOWN", "The target tab does not exist.");

    const roots = new Set<string>(this.configuredRoots);
    const docsRoot = await canonicalDirectory(path.join(this.rootDir, "docs"));
    if (docsRoot) roots.add(docsRoot);
    const workingRoot = bundle.tab.session.workingDirectory
      ? await canonicalDirectory(bundle.tab.session.workingDirectory)
      : null;
    if (workingRoot) roots.add(workingRoot);

    let base: string | null = null;
    if (request.parentDocId) {
      // Memos live in memory, so every parent id is unknown after a restart.
      // That is a stale viewer, not a permission problem, and saying "outside
      // the allowed directories" sends the reader looking for the wrong thing.
      const parent = this.memo.get(request.parentDocId);
      if (!parent) throw new DocumentError(409, "DOCUMENT_PARENT_UNKNOWN", "The containing document must be opened again.");
      if (!parent.authorizedTabIds.has(request.tabId)) {
        throw new DocumentError(403, "DOCUMENT_ACCESS_DENIED", "The parent document is not authorized for this tab.");
      }
      base = path.dirname(parent.canonicalPath);
      for (const root of parent.authorizedRoots) roots.add(root);
    } else if (request.answerId) {
      // A page that has not caught up sends the answer id it last saw, and
      // history reconciliation can replace those records underneath it.
      // Naming an answer only ever widens what is reachable, so an id this tab
      // no longer has falls back to the working directory -- the same position
      // as sending no id at all. Sending a stale one must not be worse than
      // sending none, which is what refusing here made it.
      const answer = bundle.answers.answers.find((record) => record.id === request.answerId);
      const storedBase = answer?.metadata.documentBasePath;
      if (typeof storedBase === "string") {
        base = await canonicalDirectory(storedBase);
        if (!base) throw new DocumentError(404, "DOCUMENT_NOT_FOUND", "The answer's document directory no longer exists.");
        roots.add(base);
      } else base = workingRoot;
    } else {
      base = workingRoot;
    }

    let candidate: string;
    if (path.isAbsolute(parsed.path) || /^[a-z]:[\\/]/i.test(parsed.path)) candidate = path.normalize(parsed.path);
    else {
      if (!base) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The document location cannot be determined.");
      candidate = path.resolve(base, parsed.path);
    }
    assertSafeCandidate(candidate, this.configuredRoots);

    let canonicalPath: string;
    try { canonicalPath = await fs.realpath(candidate); }
    catch (error) { throw fileSystemDocumentError(error, path.basename(candidate)); }
    const authorizedRoots = [...roots].filter((root) => containsPath(root, canonicalPath));
    if (authorizedRoots.length === 0) throw documentError(403, "DOCUMENT_ACCESS_DENIED", "The document is outside the allowed directories.", path.basename(canonicalPath));

    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(canonicalPath, "r");
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile()) throw documentError(400, "DOCUMENT_IS_DIRECTORY", "The document target is not a regular file.", path.basename(canonicalPath));
      return { canonicalPath, name: path.basename(canonicalPath), stat, roots: authorizedRoots };
    } catch (error) {
      if (error instanceof DocumentError) throw error;
      throw fileSystemDocumentError(error, path.basename(canonicalPath));
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private documentId(canonicalPath: string): string {
    return this.hmac(process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath);
  }

  private revision(docId: string, stat: any): string {
    return this.hmac(JSON.stringify({
      docId,
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs) * 1_000_000))),
      ctimeNs: String(stat.ctimeNs ?? BigInt(Math.trunc(Number(stat.ctimeMs) * 1_000_000))),
    }));
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.key).update(value, "utf8").digest("base64url").slice(0, 22);
  }

  private confirmationToken(canonicalPath: string, revision: string): string {
    const expires = this.now() + CONFIRMATION_TTL_MS;
    return `${expires}.${createHmac("sha256", this.key).update(confirmationPayload(canonicalPath, revision, expires)).digest("base64url")}`;
  }

  private validConfirmationToken(token: string, canonicalPath: string, revision: string): boolean {
    const [expiresRaw, signature, extra] = token.split(".");
    const expires = Number(expiresRaw);
    if (extra !== undefined || !Number.isSafeInteger(expires) || expires < this.now() || expires > this.now() + CONFIRMATION_TTL_MS) return false;
    const expected = createHmac("sha256", this.key).update(confirmationPayload(canonicalPath, revision, expires)).digest();
    let actual: Buffer;
    try { actual = Buffer.from(signature ?? "", "base64url"); } catch { return false; }
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private touchMemo(entry: DocumentMemo): void {
    this.memo.delete(entry.docId);
    this.memo.set(entry.docId, entry);
    while (this.memo.size > DOCUMENT_MEMO_MAX_ENTRIES) this.memo.delete(this.memo.keys().next().value!);
  }
}

export function isLocalBrowserRequest(headers: Record<string, string | string[] | undefined>): boolean {
  const hostValue = firstHeader(headers.host);
  if (!hostValue || !isLoopbackHostname(hostnameFromAuthority(hostValue))) return false;
  const browserSources = [firstHeader(headers.origin), firstHeader(headers.referer)].filter((value): value is string => Boolean(value));
  if (browserSources.length === 0) return false;
  return browserSources.every((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHostname(url.hostname);
    } catch { return false; }
  });
}

async function readOrCreateDocumentKey(privateDir: string): Promise<Buffer> {
  await fs.mkdir(privateDir, { recursive: true });
  const keyPath = path.join(privateDir, "document-key");
  try {
    const existing = await fs.readFile(keyPath);
    if (existing.length === 32) return existing;
    throw new Error("The persisted document key has an invalid length.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  try {
    const handle = await fs.open(keyPath, "wx", 0o600);
    try { await handle.writeFile(key); } finally { await handle.close(); }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(keyPath);
    if (existing.length !== 32) throw new Error("The persisted document key has an invalid length.");
    return existing;
  }
}

async function canonicalExistingDirectories(values: string[]): Promise<string[]> {
  const roots = await Promise.all(values.map(canonicalDirectory));
  return [...new Set(roots.filter((value): value is string => Boolean(value)).map((value) => normalizedPath(value)))];
}

async function canonicalDirectory(value: string): Promise<string | null> {
  try {
    const canonical = await fs.realpath(path.resolve(value));
    return (await fs.stat(canonical)).isDirectory() ? canonical : null;
  } catch { return null; }
}

function assertOpenRequest(request: DocumentOpenRequest): void {
  if (!request || typeof request.href !== "string" || Buffer.byteLength(request.href, "utf8") > DOCUMENT_HREF_MAX_BYTES) {
    throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The document link is empty or too long.");
  }
  if (typeof request.tabId !== "string" || !request.tabId || request.tabId.length > 128) {
    throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The document tab identifier is invalid.");
  }
  if (request.answerId && request.parentDocId) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "A document link cannot have two base references.");
  if (request.answerId && (typeof request.answerId !== "string" || request.answerId.length > 128)) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The answer identifier is invalid.");
  if (request.parentDocId && !DOCUMENT_ID_RE.test(request.parentDocId)) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The parent document identifier is invalid.");
}

function parseLocalHref(rawHref: string): { path: string } {
  const hashIndex = rawHref.indexOf("#");
  const withoutFragment = hashIndex >= 0 ? rawHref.slice(0, hashIndex) : rawHref;
  if (withoutFragment.includes("?")) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "Local document links cannot contain a query.");
  let decoded: string;
  if (/^file:/i.test(withoutFragment)) {
    let url: URL;
    try { url = new URL(withoutFragment); } catch { throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The file URI is invalid."); }
    if (url.protocol !== "file:" || url.hostname) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "Remote file URI hosts are not allowed.");
    try { decoded = fileURLToPath(url); } catch { throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The file URI encoding is invalid."); }
    if (process.platform !== "win32" && /^\/[a-z]:\//i.test(decoded)) decoded = decoded.slice(1);
  } else {
    try { decoded = decodeURIComponent(withoutFragment); }
    catch { throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The document path encoding is invalid."); }
  }
  if (/%[0-9a-f]{2}/i.test(decoded)) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "Double-encoded document paths are not allowed.");
  if (decoded.includes("?") || /[\0-\x1f\x7f]/.test(decoded)) throw new DocumentError(400, "DOCUMENT_LINK_INVALID", "The document path contains forbidden characters.");
  // Done here independently of whatever the page sent: this is the security
  // boundary, and `notes.md:140` has to reach assertSafeCandidate as a path
  // rather than as something indistinguishable from an NTFS stream.
  const withoutLine = splitLineAnchor(decoded).path;
  return { path: withoutLine.replace(/^\/([a-z]:[\\/])/i, "$1") };
}

function assertSafeCandidate(candidate: string, configuredRoots: string[]): void {
  const normalized = candidate.replace(/\//g, "\\");
  if (/^(?:\\\\[?.]\\|\\\?\?\\)/.test(normalized)) throw new DocumentError(403, "DOCUMENT_ACCESS_DENIED", "Windows device paths are not allowed.");
  if (normalized.startsWith("\\\\") && !configuredRoots.some((root) => root.startsWith("\\\\") && containsPath(root, candidate))) {
    throw new DocumentError(403, "DOCUMENT_ACCESS_DENIED", "UNC paths require an explicitly configured document root.");
  }
  const afterDrive = /^[a-z]:/i.test(normalized) ? normalized.slice(2) : normalized;
  if (afterDrive.includes(":")) throw new DocumentError(403, "DOCUMENT_ACCESS_DENIED", "NTFS alternate data streams are not allowed.");
}

async function assertSupportedBom(canonicalPath: string, name: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(canonicalPath, "r");
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    const head = bytes.subarray(0, bytesRead);
    const unsupported = head[0] === 0xff && head[1] === 0xfe
      || head[0] === 0xfe && head[1] === 0xff
      || head[0] === 0x00 && head[1] === 0x00 && head[2] === 0xfe && head[3] === 0xff
      || head[0] === 0xff && head[1] === 0xfe && head[2] === 0x00 && head[3] === 0x00;
    if (unsupported) throw documentError(415, "DOCUMENT_ENCODING_UNSUPPORTED", "Remote preview requires UTF-8 text.", name);
  } finally { await handle?.close().catch(() => undefined); }
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(normalizedPath(root), normalizedPath(candidate));
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function confirmationPayload(canonicalPath: string, revision: string, expires: number): string {
  return JSON.stringify({ path: process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath, revision, expires });
}

function documentError(statusCode: number, code: string, message: string, name: string): DocumentError {
  return new DocumentError(statusCode, code, message, { name });
}

function fileSystemDocumentError(error: unknown, name: string, fallbackCode = "DOCUMENT_NOT_FOUND"): DocumentError {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return documentError(404, "DOCUMENT_NOT_FOUND", "The document does not exist.", name);
  if (code === "EACCES" || code === "EPERM") return documentError(403, "DOCUMENT_ACCESS_DENIED", "The document cannot be accessed.", name);
  return documentError(500, fallbackCode, "The document could not be read.", name);
}

function firstHeader(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function hostnameFromAuthority(authority: string): string {
  try { return new URL(`http://${authority}`).hostname; } catch { return ""; }
}

function openWithWindowsDefaultApplication(absolutePath: string): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows only"));
  return new Promise<void>((resolve, reject) => {
    const child = execFile("explorer.exe", [absolutePath], { windowsHide: true });
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
}
