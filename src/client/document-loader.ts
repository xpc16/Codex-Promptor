import type { DocumentOpenMetadata, DocumentOpenRequest } from "../shared/document-protocol.js";
import {
  DOCUMENT_ID_RE,
  DOCUMENT_REMOTE_MAX_BYTES,
  DOCUMENT_REVISION_RE,
  DOCUMENT_SCROLL_AUTOLOAD_LIMIT_BYTES,
  documentChunkRange,
} from "../shared/document-protocol.js";
import { PromptorApiError } from "./i18n.js";
import { api, jsonBody, promptorApiHeaders } from "./api-client.js";
import { MarkdownBlockAssembler } from "./markdown-blocks.js";

export type DocumentViewerStatus = "closed" | "opening" | "open" | "loading" | "error";

export type DocumentViewerState = {
  status: DocumentViewerStatus;
  viewerReserved: boolean;
  documentEpoch: number;
  source: DocumentOpenRequest | null;
  docId: string | null;
  name: string;
  kind: DocumentOpenMetadata["kind"] | null;
  revision: string | null;
  textSegments: string[];
  markdownBlocks: string[];
  pendingMarkdown: string;
  loadedBytes: number;
  totalBytes: number;
  nextChunkIndex: number;
  complete: boolean;
  error: PromptorApiError | Error | null;
};

export type DocumentTransport = {
  open: (request: DocumentOpenRequest, signal: AbortSignal) => Promise<DocumentOpenMetadata>;
  chunk: (metadata: DocumentOpenMetadata, index: number, signal: AbortSignal) => Promise<Uint8Array>;
};

/**
 * How many containing documents may be reopened to follow one link.
 *
 * A restart invalidates every id at once, so a reader three documents deep has
 * a whole stale chain behind them. Walking it is bounded rather than open:
 * beyond a few steps the reopening is more surprising than the error.
 */
const MAX_PARENT_REFRESH_DEPTH = 3;

/**
 * Whether a failed link click should be retried by reopening the document it
 * was clicked in.
 *
 * The server keeps its document registry in memory, so a page left open across
 * a restart holds ids that no longer exist and sends one as the link's parent.
 * Nothing is wrong with the link or the file -- only the handle is stale, and
 * minting a fresh one resolves the link exactly as it would have resolved
 * before. Dropping the parent instead would be wrong: it moves a relative
 * href's base from the containing document's directory to the tab's working
 * directory, which can quietly open a different file.
 */
export function shouldRefreshStaleParent(input: {
  code: string | null;
  /** The parent id the failed request carried. */
  parentDocId: string | undefined;
  /** The document that was open when the link was clicked. */
  openDocId: string | null;
  depth: number;
}): boolean {
  if (input.code !== "DOCUMENT_PARENT_UNKNOWN" || !input.parentDocId) return false;
  // Only the document being navigated from can be reissued; an id from
  // anywhere else is not this viewer's to refresh.
  if (input.openDocId !== input.parentDocId) return false;
  return input.depth < MAX_PARENT_REFRESH_DEPTH;
}

const initialState = (epoch = 0): DocumentViewerState => ({
  status: "closed",
  viewerReserved: false,
  documentEpoch: epoch,
  source: null,
  docId: null,
  name: "",
  kind: null,
  revision: null,
  textSegments: [],
  markdownBlocks: [],
  pendingMarkdown: "",
  loadedBytes: 0,
  totalBytes: 0,
  nextChunkIndex: 0,
  complete: false,
  error: null,
});

export class DocumentLoader {
  private stateValue = initialState();
  private readonly listeners = new Set<(state: DocumentViewerState) => void>();
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private assembler = new MarkdownBlockAssembler();
  private controller: AbortController | null = null;
  private fetchAttempt = 0;
  private inFlight = false;
  private active = true;
  private reopenedUnknownId = false;

  constructor(private readonly transport: DocumentTransport = browserDocumentTransport) {}

  get state(): DocumentViewerState { return this.stateValue; }

  subscribe(listener: (state: DocumentViewerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);
    return () => { this.listeners.delete(listener); };
  }

  async open(source: DocumentOpenRequest, reopenedUnknownId = false, refreshDepth = 0): Promise<void> {
    const reserveViewer = this.stateValue.viewerReserved;
    // Captured before the state is replaced below: recovering from a stale
    // parent id needs the document the reader was standing in.
    const from = this.stateValue.source;
    const fromDocId = this.stateValue.docId;
    this.abort();
    const epoch = this.stateValue.documentEpoch + 1;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.assembler = new MarkdownBlockAssembler();
    this.reopenedUnknownId = reopenedUnknownId;
    this.set({ ...initialState(epoch), status: "opening", viewerReserved: reserveViewer, source });
    const controller = new AbortController();
    this.controller = controller;
    const attempt = ++this.fetchAttempt;
    try {
      const metadata = await this.transport.open(source, controller.signal);
      if (!this.current(epoch, attempt, controller.signal)) return;
      assertMetadata(metadata);
      this.controller = null;
      this.set({
        ...initialState(epoch),
        status: "open",
        viewerReserved: true,
        source,
        docId: metadata.docId,
        name: metadata.name,
        kind: metadata.kind,
        revision: metadata.revision,
        totalBytes: metadata.size,
        complete: metadata.size === 0,
      });
    } catch (error) {
      if (!this.current(epoch, attempt, controller.signal) || isAbort(error)) return;
      this.controller = null;
      const failure = asError(error);
      const code = failure instanceof PromptorApiError ? failure.code : null;
      if (from && shouldRefreshStaleParent({ code, parentDocId: source.parentDocId, openDocId: fromDocId, depth: refreshDepth })) {
        // Reopen the containing document first, then follow the link from the
        // id that comes back. Each level of a stale chain unwinds the same way,
        // and a failure on the way leaves its own error on screen.
        await this.open(from, false, refreshDepth + 1);
        const parentDocId = this.stateValue.docId;
        if (this.stateValue.status === "open" && parentDocId) {
          await this.open({ ...source, parentDocId }, false, refreshDepth + 1);
        }
        return;
      }
      this.set({ ...this.stateValue, status: "error", error: failure });
    }
  }

  async loadNext(manual = true): Promise<void> {
    const state = this.stateValue;
    if (!this.active || this.inFlight || state.complete || !state.docId || !state.revision || !state.kind || !state.source) return;
    if (!manual && !this.canAutoLoad()) return;
    this.inFlight = true;
    const epoch = state.documentEpoch;
    const index = state.nextChunkIndex;
    const metadata: DocumentOpenMetadata = {
      docId: state.docId,
      revision: state.revision,
      name: state.name,
      kind: state.kind,
      size: state.totalBytes,
      encoding: "utf-8",
    };
    const controller = new AbortController();
    this.controller = controller;
    const attempt = ++this.fetchAttempt;
    this.set({ ...state, status: "loading", error: null });
    try {
      const bytes = await this.transport.chunk(metadata, index, controller.signal);
      if (!this.current(epoch, attempt, controller.signal)) return;
      const expected = documentChunkRange(state.totalBytes, index);
      if (!expected || bytes.byteLength !== expected.length) {
        throw new PromptorApiError("DOCUMENT_CHUNK_FAILED", "The document server returned an invalid chunk length.", 502, false);
      }
      const loadedBytes = state.loadedBytes + bytes.byteLength;
      const complete = loadedBytes >= state.totalBytes;
      let decoded: string;
      try {
        decoded = this.decoder.decode(bytes, { stream: !complete });
        if (complete) decoded += this.decoder.decode();
      } catch {
        throw new PromptorApiError("DOCUMENT_ENCODING_UNSUPPORTED", "The document is not valid UTF-8.", 415, false);
      }
      const update: Partial<DocumentViewerState> = {};
      if (state.kind === "text") update.textSegments = [...state.textSegments, decoded];
      else {
        const assembled = this.assembler.append(decoded, complete);
        update.markdownBlocks = [...state.markdownBlocks, ...assembled.blocks];
        update.pendingMarkdown = assembled.pending;
      }
      this.set({
        ...this.stateValue,
        ...update,
        status: "open",
        loadedBytes,
        nextChunkIndex: index + 1,
        complete,
        error: null,
      });
    } catch (error) {
      if (!this.current(epoch, attempt, controller.signal) || isAbort(error)) return;
      const failure = asError(error);
      if (failure instanceof PromptorApiError && failure.code === "DOCUMENT_ID_UNKNOWN" && !this.reopenedUnknownId) {
        this.inFlight = false;
        this.controller = null;
        await this.open(state.source, true);
        return;
      }
      this.set({ ...this.stateValue, status: "error", error: failure });
    } finally {
      if (this.current(epoch, attempt, controller.signal)) this.controller = null;
      this.inFlight = false;
    }
  }

  retry(): Promise<void> {
    if (!this.stateValue.docId && this.stateValue.source) return this.open(this.stateValue.source);
    return this.loadNext(true);
  }

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.abortRequestOnly();
      this.inFlight = false;
      if (this.stateValue.status === "loading") this.set({ ...this.stateValue, status: "open" });
    }
  }

  canAutoLoad(): boolean {
    return this.stateValue.loadedBytes < DOCUMENT_SCROLL_AUTOLOAD_LIMIT_BYTES;
  }

  close(): void {
    this.abort();
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.assembler.reset();
    this.set(initialState(this.stateValue.documentEpoch + 1));
  }

  private abort(): void {
    this.abortRequestOnly();
    this.inFlight = false;
  }

  private abortRequestOnly(): void {
    this.fetchAttempt += 1;
    this.controller?.abort();
    this.controller = null;
  }

  private current(epoch: number, attempt: number, signal: AbortSignal): boolean {
    return !signal.aborted && epoch === this.stateValue.documentEpoch && attempt === this.fetchAttempt;
  }

  private set(state: DocumentViewerState): void {
    this.stateValue = state;
    for (const listener of this.listeners) listener(state);
  }
}

export const browserDocumentTransport: DocumentTransport = {
  open: (request, signal) => api<DocumentOpenMetadata>("/api/documents/open", { ...jsonBody(request), cache: "no-store", signal }),
  chunk: async (metadata, index, signal) => {
    const response = await fetch(`/api/documents/${encodeURIComponent(metadata.docId)}/chunks/${index}?rev=${encodeURIComponent(metadata.revision)}`, {
      method: "GET",
      headers: promptorApiHeaders(),
      cache: "default",
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new PromptorApiError(
        String(payload?.error?.code ?? "DOCUMENT_CHUNK_FAILED"),
        String(payload?.error?.message ?? `HTTP ${response.status}`),
        response.status,
        Boolean(payload?.error?.retryable),
        payload?.error?.details && typeof payload.error.details === "object" ? payload.error.details : {},
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  },
};

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertMetadata(value: DocumentOpenMetadata): void {
  if (!value || !DOCUMENT_ID_RE.test(value.docId) || !DOCUMENT_REVISION_RE.test(value.revision)
    || (value.kind !== "text" && value.kind !== "markdown") || value.encoding !== "utf-8"
    || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > DOCUMENT_REMOTE_MAX_BYTES
    || typeof value.name !== "string" || value.name.length === 0 || value.name.length > 512) {
    throw new PromptorApiError("DOCUMENT_CHUNK_FAILED", "The document server returned invalid metadata.", 502, false);
  }
}
