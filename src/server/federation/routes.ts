import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  RELAY_METHODS,
  REQUEST_HEADERS,
  isDeviceId,
  pickHeaders,
  relayPath,
} from "../../shared/federation-protocol.js";
import { FederationError, type LinkAuthResult } from "./hub.js";
import type { FederationService } from "./service.js";

/**
 * The routes federation adds.
 *
 *   /federation/link        a member's link (hub only, device token)
 *   /d/:deviceId/…          another device's `/api/…`, for a page here
 *   /d/:deviceId/ws         another device's `/ws`, for a page here
 *   GET /api/federation     the device list a page renders
 *   /api/federation/admin/… settings, from this machine's own page only
 *
 * The relay routes live in their own plugin, and that is what keeps this
 * machine's encryption out of them: they take bodies as raw bytes (the
 * global parser would try to open a sealed body with this machine's key),
 * compression is off (the far device already compressed), and their URLs do
 * not start with `/api/`, so the sealing hook passes them by. A relay only
 * carries bytes; the device that owns the conversation opens and seals them.
 */

/** Room for the largest accepted body (common prompts, 1 MiB) plus envelope overhead. */
export const RELAY_BODY_LIMIT = 2 * 1024 * 1024;

type Deps = {
  federation: FederationService;
  /** The existing page authentication: the app token or a trusted same-origin page. */
  apiAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  isLocalBrowserRequest: (headers: Record<string, string | string[] | undefined>) => boolean;
};

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ error: { code, message, details: {}, retryable: status >= 500 } });

export async function registerFederationRoutes(app: FastifyInstance, deps: Deps): Promise<void> {
  const { federation } = deps;

  app.get("/federation/link", {
    websocket: true,
    // Checked before any upgrade: an unknown caller gets an HTTP status and
    // never a WebSocket.
    onRequest: async (request, reply) => {
      const result = await federation.authenticateLink(request.headers as Record<string, unknown>);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      (request as FastifyRequest & { federationLink?: LinkAuthResult }).federationLink = result;
    },
  }, (socket, request) => {
    const auth = (request as FastifyRequest & { federationLink?: LinkAuthResult }).federationLink;
    if (!auth?.ok) { socket.close(1008, "unauthorized"); return; }
    federation.attachLink(socket, auth);
  });

  await app.register(async (relay) => {
    relay.removeAllContentTypeParsers();
    relay.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: RELAY_BODY_LIMIT }, (_request, body, done) => done(null, body));
    relay.addHook("onRequest", async (request, reply) => {
      if (federation.mode() === "off") return fail(reply, 404, "FEDERATION_OFF", "Multi-device access is not enabled on this machine.");
      // A member asking on behalf of its own page carries its device token
      // (hub only). Everyone else is a page and authenticates as pages do.
      if (federation.verifyDeviceRequest(request.headers as Record<string, unknown>)) return;
      await deps.apiAuth(request, reply);
    });

    relay.get("/d/:deviceId/ws", { websocket: true }, (socket, request) => {
      const target = String((request.params as { deviceId?: unknown }).deviceId ?? "");
      if (!isDeviceId(target)) { socket.close(1008, "invalid device"); return; }
      federation.forwardSocket(target, socket);
    });

    relay.route({
      method: [...RELAY_METHODS] as Array<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">,
      url: "/d/:deviceId/*",
      compress: false,
      bodyLimit: RELAY_BODY_LIMIT,
      handler: async (request, reply) => {
        const target = String((request.params as { deviceId?: unknown }).deviceId ?? "");
        if (!isDeviceId(target)) return fail(reply, 400, "FEDERATION_DEVICE_INVALID", "That is not a device id.");
        const logical = relayPath(request.url.slice(`/d/${target}`.length));
        if (!logical || !RELAY_METHODS.has(request.method)) return fail(reply, 400, "FEDERATION_PATH_INVALID", "Only this device's /api/ routes can be reached through another machine.");
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        try {
          const result = await federation.forwardHttp(target, {
            method: request.method,
            path: logical,
            headers: pickHeaders(request.headers as Record<string, unknown>, REQUEST_HEADERS),
          }, body);
          reply.code(result.head.status);
          for (const [name, value] of Object.entries(result.head.headers)) reply.header(name, value);
          return reply.send(result.body);
        } catch (error) {
          if (error instanceof FederationError) return fail(reply, error.status, error.code, error.message);
          throw error;
        }
      },
    });
  });

  app.get("/api/federation", async (_request, reply) => reply.send({ data: federation.view() }));

  const localOnly = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!deps.isLocalBrowserRequest(request.headers)) {
        return fail(reply, 403, "FEDERATION_LOCAL_ONLY", "Multi-device settings can only be changed from this machine's own page.");
      }
      try { return await handler(request, reply); }
      catch (error) {
        if (error instanceof FederationError) return fail(reply, error.status, error.code, error.message);
        throw error;
      }
    };
  const body = (request: FastifyRequest): Record<string, unknown> => (request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {});
  const key = (request: FastifyRequest): string => String((request.params as { key?: unknown }).key ?? "");

  app.get("/api/federation/admin", localOnly(async (_request, reply) => reply.send({ data: federation.adminView() })));
  app.post("/api/federation/admin/hub", localOnly(async (request, reply) => reply.send({ data: await federation.enableHub(body(request).name, body(request).publicUrl) })));
  app.post("/api/federation/admin/join", localOnly(async (request, reply) => reply.send({ data: await federation.join(body(request).joinCode, body(request).name) })));
  app.post("/api/federation/admin/leave", localOnly(async (_request, reply) => reply.send({ data: await federation.leave() })));
  app.post("/api/federation/admin/reset-identity", localOnly(async (_request, reply) => reply.send({ data: await federation.resetIdentity() })));
  app.post("/api/federation/admin/retry", localOnly(async (_request, reply) => reply.send({ data: federation.retry() })));
  app.post("/api/federation/admin/devices", localOnly(async (request, reply) => {
    const input = body(request);
    return reply.send({ data: await federation.addDevice(input.name, input.accessId, input.accessSecret) });
  }));
  app.patch("/api/federation/admin/devices/:key", localOnly(async (request, reply) => reply.send({ data: await federation.renameDevice(key(request), body(request).name) })));
  app.delete("/api/federation/admin/devices/:key", localOnly(async (request, reply) => reply.send({ data: await federation.removeDevice(key(request)) })));
}
