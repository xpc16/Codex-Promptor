import { PromptorApiError } from "./i18n.js";
import { E2EE_BODY_CONTENT_TYPE, E2EE_BODY_HEADER, bodyMustStayReadable, bodyNeedsEncryption } from "../shared/e2ee-http.js";
import { openResponseBody, sealRequestBody } from "./e2ee-client.js";
import { currentKey, e2eeState } from "./e2ee-gate.js";

export const promptorToken = typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("token") ?? "";

export function promptorApiHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  headers.set("x-codex-promptor-token", promptorToken);
  return headers;
}

/**
 * Every HTTP call the page makes goes through here, which is what lets the
 * sealing be in one place rather than at each call site.
 *
 * The request body is sealed and the response opened only when encryption is
 * on for this page. Bootstrap is exempt on the server, because a page cannot
 * be asked for a key using a message it cannot read.
 */
async function e2eeFetch(url: string, init: RequestInit): Promise<Response> {
  const headers = promptorApiHeaders(init.headers);
  const state = e2eeState();
  const key = currentKey();
  if (!state.required || bodyMustStayReadable(url) || !bodyNeedsEncryption(url)) {
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    return fetch(url, { ...init, headers });
  }
  // Encryption is on and there is no key yet. Sending in the clear would put
  // the thing this exists to protect on the wire; sending sealed is not
  // possible. Refusing is the only honest option, and the reader is already
  // looking at the prompt that fixes it.
  if (!key) throw new PromptorApiError("E2EE_LOCKED", "Waiting for the encryption key.", 401, false);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return fetch(url, { ...init, headers });
  // Close/reopen/delete actions have no JSON arguments, but still need a
  // valid encrypted envelope. Advertising ciphertext and sending zero bytes
  // makes the server's body parser reject the request with HTTP 403.
  // Seal {} rather than exempting empty writes from the key check.
  headers.set("content-type", E2EE_BODY_CONTENT_TYPE);
  const plaintext = init.body === undefined || init.body === null || init.body === ""
    ? "{}"
    : typeof init.body === "string" ? init.body : String(init.body);
  const body = await sealRequestBody(key, plaintext) as BodyInit;
  return fetch(url, { ...init, headers, body });
}

/** Opens the body when it arrives sealed, and reads it plainly when it does not. */
async function readPayload(response: Response): Promise<any> {
  if (!response.headers.get(E2EE_BODY_HEADER)) return response.json().catch(() => ({}));
  const key = currentKey();
  if (!key) throw new PromptorApiError("E2EE_LOCKED", "Waiting for the encryption key.", 401, false);
  const opened = await openResponseBody(key, new Uint8Array(await response.arrayBuffer()));
  if (opened === null) throw new PromptorApiError("E2EE_BODY_UNREADABLE", "This response was sealed with a different key.", 403, false);
  try { return JSON.parse(opened); } catch { return {}; }
}

function responseError(payload: any, status: number): PromptorApiError {
  // Route errors use our nested shape; parser errors occur before the route
  // and use Fastify's { code, message, error: "Forbidden", statusCode } shape.
  const error = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  return new PromptorApiError(
    String(error?.code ?? "HTTP_ERROR"),
    String(error?.message ?? `HTTP ${status}`),
    status,
    Boolean(error?.retryable),
    error?.details && typeof error.details === "object" ? error.details : {},
  );
}

export async function api<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await e2eeFetch(url, init);
  const payload = await readPayload(response);
  if (!response.ok) throw responseError(payload, response.status);
  return payload.data as T;
}

export type ApiResponse<T> = { data: T | null; etag: string | null; notModified: boolean; status: number };

/** Small conditional-resource helper used by on-demand dialogs. */
export async function apiResponse<T = any>(url: string, init: RequestInit = {}): Promise<ApiResponse<T>> {
  const response = await e2eeFetch(url, init);
  if (response.status === 304) return { data: null, etag: response.headers.get("etag"), notModified: true, status: 304 };
  const payload = await readPayload(response);
  if (!response.ok) throw responseError(payload, response.status);
  return { data: payload.data as T, etag: response.headers.get("etag"), notModified: false, status: response.status };
}

export function jsonBody(value: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(value) };
}
