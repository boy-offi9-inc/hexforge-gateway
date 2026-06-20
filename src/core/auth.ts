import type { FastifyInstance } from "fastify";
import { apiKeys, isAuthEffectivelyEnabled } from "./config.js";

/**
 * Opt-in API key auth. Off by default (AUTH_ENABLED=false) - this Gateway
 * has always trusted whoever can reach it (adb shell, filesystem
 * write/delete, rebuilding APKs), which was a reasonable default for a
 * local single-user tool but stops being one the moment it's reachable
 * beyond localhost - e.g. once a web interface exists.
 *
 * Deliberately simple: one or more shared keys (API_KEYS, comma-
 * separated), checked via the `Authorization: Bearer <key>` header or an
 * `X-API-Key: <key>` header, no per-key scopes or expiry. This is a
 * single-operator tool, not a multi-tenant service - if that changes,
 * this is the file to replace, not patch.
 *
 * GET /health is always exempt, so uptime checks / the startup banner's
 * "is it up" check don't need a key. Everything else, including GET /
 * (which lists workspace names), requires one when auth is enabled.
 */
export async function registerAuth(app: FastifyInstance): Promise<void> {
  if (!isAuthEffectivelyEnabled) return;

  app.addHook("onRequest", async (req, reply) => {
    if (req.method === "GET" && req.url === "/health") return;

    const header = req.headers.authorization;
    const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const key = bearer ?? (req.headers["x-api-key"] as string | undefined);

    if (!key || !apiKeys.has(key)) {
      reply.code(401).send({ error: "Missing or invalid API key. Send it as \"Authorization: Bearer <key>\" or \"X-API-Key: <key>\"." });
    }
  });
}
