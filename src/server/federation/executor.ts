import type { FastifyInstance } from "fastify";
import type WebSocket from "ws";
import {
  FEDERATION_HOST,
  REQUEST_HEADERS,
  RESPONSE_HEADERS,
  pickHeaders,
  type RequestHead,
  type ResponseHead,
} from "../../shared/federation-protocol.js";

/**
 * Running a request that another machine forwarded, through this machine's
 * own routes.
 *
 * No handler registry and no second copy of any business logic: the request
 * is injected into the same Fastify instance a browser talks to. What makes
 * it a *remote* request is how its headers are built -- from nothing, never
 * copied. Host is the reserved `federation.invalid`, so every check that asks
 * "is this the machine's own page" (folder picker, opening files, export,
 * changing encryption, A2A) says no, the scope classifier files it as
 * `federation`, and encryption, redaction and handshakes apply exactly as
 * they do to a request that came through the tunnel.
 *
 * The app token is this machine's own. It authenticates the injection to
 * itself and never leaves the process.
 */

const fixedHeaders = (): Record<string, string> => ({ host: FEDERATION_HOST, "x-forwarded-for": "federation" });

export type ExecutedResponse = { head: ResponseHead; body: Buffer };

export async function executeHttp(app: FastifyInstance, token: string, head: RequestHead, body: Uint8Array): Promise<ExecutedResponse> {
  const response = await app.inject({
    method: head.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: head.path,
    headers: { ...pickHeaders(head.headers, REQUEST_HEADERS), ...fixedHeaders(), "x-codex-promptor-token": token },
    ...(body.length ? { payload: Buffer.from(body.buffer, body.byteOffset, body.byteLength) } : {}),
    remoteAddress: "federation",
  });
  return {
    head: { status: response.statusCode, headers: pickHeaders(response.headers as Record<string, unknown>, RESPONSE_HEADERS) },
    body: response.rawPayload,
  };
}

/**
 * A real `ws` connection to this machine's `/ws` handler, through
 * @fastify/websocket's `injectWS`: an in-memory duplex and the genuine
 * upgrade path, so the handler sees exactly what a browser would give it.
 */
export function openLocalSocket(app: FastifyInstance, token: string): Promise<WebSocket> {
  return app.injectWS(`/ws?token=${encodeURIComponent(token)}`, { headers: fixedHeaders() });
}
