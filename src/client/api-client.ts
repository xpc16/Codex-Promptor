import { PromptorApiError } from "./i18n.js";

export const promptorToken = typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("token") ?? "";

export function promptorApiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("x-codex-promptor-token", promptorToken);
  return headers;
}

export async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = promptorApiHeaders(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new PromptorApiError(
    String(payload?.error?.code ?? "HTTP_ERROR"),
    String(payload?.error?.message ?? `HTTP ${response.status}`),
    response.status,
    Boolean(payload?.error?.retryable),
    payload?.error?.details && typeof payload.error.details === "object" ? payload.error.details : {},
  );
  return payload.data as T;
}

export type ApiResponse<T> = { data: T | null; etag: string | null; notModified: boolean; status: number };

/** Small conditional-resource helper used by on-demand dialogs. */
export async function apiResponse<T = any>(url: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const headers = promptorApiHeaders(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, headers });
  if (response.status === 304) return { data: null, etag: response.headers.get("etag"), notModified: true, status: 304 };
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new PromptorApiError(
    String(payload?.error?.code ?? "HTTP_ERROR"),
    String(payload?.error?.message ?? `HTTP ${response.status}`),
    response.status,
    Boolean(payload?.error?.retryable),
    payload?.error?.details && typeof payload.error.details === "object" ? payload.error.details : {},
  );
  return { data: payload.data as T, etag: response.headers.get("etag"), notModified: false, status: response.status };
}

export function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}
