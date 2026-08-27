export const DOCUMENT_FIRST_CHUNK_BYTES = 8 * 1024;
export const DOCUMENT_CHUNK_BYTES = 16 * 1024;
export const DOCUMENT_SCROLL_AUTOLOAD_LIMIT_BYTES = 512 * 1024;
export const DOCUMENT_REMOTE_MAX_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_HREF_MAX_BYTES = 8 * 1024;
export const DOCUMENT_MEMO_MAX_ENTRIES = 256;
export const DOCUMENT_RAW_CATCH_UP_BYTES = 64 * 1024;

export const DOCUMENT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const DOCUMENT_REVISION_RE = /^[A-Za-z0-9_-]{22}$/;

export type DocumentKind = "text" | "markdown";

export type DocumentOpenRequest = {
  href: string;
  tabId: string;
  answerId?: string;
  parentDocId?: string;
};

export type DocumentOpenMetadata = {
  docId: string;
  name: string;
  kind: DocumentKind;
  size: number;
  revision: string;
  encoding: "utf-8";
};

export type DocumentLocalOpenResult = {
  name: string;
  opened: boolean;
  requiresConfirmation?: boolean;
  confirmationToken?: string;
  fileType?: string;
};

export type DocumentChunkRange = { start: number; length: number; last: boolean };

export function documentChunkCount(size: number): number {
  if (!Number.isSafeInteger(size) || size <= 0) return 0;
  if (size <= DOCUMENT_FIRST_CHUNK_BYTES) return 1;
  return 1 + Math.ceil((size - DOCUMENT_FIRST_CHUNK_BYTES) / DOCUMENT_CHUNK_BYTES);
}

export function documentChunkRange(size: number, index: number): DocumentChunkRange | null {
  const count = documentChunkCount(size);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) return null;
  const start = index === 0 ? 0 : DOCUMENT_FIRST_CHUNK_BYTES + (index - 1) * DOCUMENT_CHUNK_BYTES;
  const maximum = index === 0 ? DOCUMENT_FIRST_CHUNK_BYTES : DOCUMENT_CHUNK_BYTES;
  const length = Math.min(maximum, size - start);
  return { start, length, last: index === count - 1 };
}
