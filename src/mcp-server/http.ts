#!/usr/bin/env node
/**
 * HexForge's MCP server frontend, Streamable HTTP transport. Same
 * protocol/tool logic as the stdio transport (index.ts) - see
 * protocol.ts, the shared core - but reachable over the network instead
 * of only by a client spawning this process locally. Use this one for a
 * remote MCP client, or any client that talks HTTP rather than spawning
 * a subprocess; use index.ts for Claude Desktop/Code, which spawn their
 * own server over stdio.
 *
 * Deliberately plain Node `http`, not Fastify - this is a separate,
 * optional process from the Gateway (which already uses Fastify for its
 * REST API) with exactly three routes and no need for a router, plugins,
 * or the Gateway's config schema. Every tool call still becomes a real
 * HTTP request to an already-running Gateway via gateway-client.ts,
 * exactly like the stdio transport - this file only adds a second way to
 * reach that same logic over the network.
 *
 * What's implemented, and what isn't:
 *  - POST /mcp - the only route that matters. One JSON-RPC message per
 *    request, one JSON-RPC message (or no body, for a notification) back.
 *    HexForge's tools never need more than one response per request and
 *    never push unsolicited server-to-client messages, so per the MCP
 *    Streamable HTTP spec's own allowance, a server that will never need
 *    to send extra messages MAY reply with a single JSON object instead
 *    of opening an SSE stream - so that's all this does. No SSE, no
 *    chunked multi-message responses, because there's never a second
 *    message to send.
 *  - GET /mcp (opening a standalone SSE stream for server-initiated
 *    messages) and DELETE /mcp (session termination) both get an honest
 *    405 rather than a fake 200 - this server never issues a session id
 *    (every tool call is already a fresh, independent Gateway request,
 *    so there's no per-connection state to key a session on) and never
 *    has anything to push down a standalone stream.
 *  - GET /health - unauthenticated liveness check, mirroring the
 *    Gateway's own /health, for process supervisors / container health
 *    checks.
 *
 * Security, since "reachable over the network" is a real change from
 * stdio's "reachable by whoever can spawn this process":
 *  - Binds to 127.0.0.1 by default (MCP_HTTP_HOST to change it). Exposing
 *    this beyond localhost hands out the same capabilities the Gateway
 *    itself has - adb shell, filesystem writes, rebuilding APKs - so set
 *    MCP_HTTP_API_KEYS before binding to anything else.
 *  - Origin header check on every request, per the MCP spec's own
 *    security guidance: a browser tab on a malicious site can send a
 *    fetch() to http://localhost:<port>/mcp (DNS rebinding doesn't even
 *    need that - localhost is already same-machine), and the browser
 *    attaches that page's Origin automatically. A non-browser client
 *    (curl, another server, most native MCP clients) simply doesn't send
 *    an Origin header at all, so requests with no Origin are allowed
 *    through; a request that does carry one must match
 *    MCP_HTTP_ALLOWED_ORIGINS (comma-separated) or gets a 403.
 *  - Optional shared-key auth: MCP_HTTP_API_KEYS (comma-separated), checked
 *    via "Authorization: Bearer <key>" or "X-API-Key: <key>" on every
 *    route except /health - deliberately the same header scheme
 *    core/auth.ts uses for the Gateway itself, so an operator manages one
 *    mental model for both. Unset (the default) means no auth, matching
 *    the Gateway's own opt-in default for local trusted use.
 *  - Per-key rate limiting (auth-hardening.ts): MCP_HTTP_RATE_LIMIT_MAX
 *    requests per key (or client IP without auth) per
 *    MCP_HTTP_RATE_LIMIT_WINDOW_MS; over the limit gets a 429.
 *  - Optional audit log of /mcp requests (auth-hardening.ts):
 *    MCP_HTTP_AUDIT_LOG, a JSON Lines file; off by default, keys are
 *    fingerprinted and tool arguments never recorded.
 *
 * Usage (after `npm run build`):
 *   node dist/mcp-server/http.js
 * Point a Streamable-HTTP-capable MCP client at http://<host>:<port>/mcp.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { handleRequest, log, type JsonRpcRequest } from "./protocol.js";
import { checkRateLimit, fingerprintKey, toolNameOf, writeAuditEntry } from "./auth-hardening.js";

const HOST = process.env.MCP_HTTP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.MCP_HTTP_PORT ?? 8788);

// Read lazily (per request) rather than at import, so a restart is the
// only thing that should pick these up but tests can also configure them.
function apiKeys(): Set<string> {
  return new Set(
    (process.env.MCP_HTTP_API_KEYS ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}
function allowedOrigins(): Set<string> {
  return new Set(
    (process.env.MCP_HTTP_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  );
}

// Same order of precedence as core/auth.ts: Authorization: Bearer, then
// X-API-Key, so the two servers behave identically from a client's
// perspective if it ever needs to talk to both with the same key.
function extractApiKey(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  const xApiKey = req.headers["x-api-key"];
  return bearer ?? (typeof xApiKey === "string" ? xApiKey : undefined);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

const MAX_BODY_BYTES = 10 * 1024 * 1024; // generous for a JSON-RPC tool call payload, small enough to bound a bad/malicious client

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // A plain Error from us, not the stream's own error object - the
        // caller sends err.message to the client, so nothing from Node
        // internals (paths, syscall details) can leak into a response.
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => reject(new Error("Request stream failed")));
  });
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  audit: { identity: string; key: string | undefined },
) {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    // Detail goes to the server log, a fixed string to the client: an error
    // message can carry internal path/stream details, and this response is
    // read by whoever sent the request.
    log("rejected request body:", err instanceof Error ? err.message : String(err));
    sendJson(res, 413, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: `Request body exceeds ${MAX_BODY_BYTES} bytes`,
      },
    });
    return;
  }

  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log("unparseable JSON-RPC request:", err instanceof Error ? err.message : String(err));
    writeAuditEntry({
      ...audit,
      method: req.method ?? "",
      outcome: "rejected",
      detail: "unparseable-json",
    });
    sendJson(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32700,
        message: "Parse error: the request body is not valid JSON",
      },
    });
    return;
  }

  const tool = toolNameOf(parsed);
  const response = await handleRequest(parsed);
  const result = response?.["result"] as { isError?: boolean } | undefined;
  writeAuditEntry({
    ...audit,
    method: req.method ?? "",
    tool,
    outcome: response?.["error"] !== undefined || result?.isError === true ? "error" : "ok",
  });
  if (!response) {
    // Notification (no "id"): per the MCP Streamable HTTP spec, a POST
    // whose input is only notifications/responses gets 202 Accepted with
    // no body - there's nothing to send back.
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

function checkOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients don't send one - see file header comment
  return allowedOrigins().has(origin);
}

function checkAuth(req: IncomingMessage): boolean {
  const keys = apiKeys();
  if (keys.size === 0) return true; // auth not configured - matches the Gateway's opt-in default
  const key = extractApiKey(req);
  return !!key && keys.has(key);
}

export async function requestListener(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      status: "ok",
      server: "hexforge-mcp-http",
      transport: "streamable-http",
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: `Not found: ${req.method} ${url.pathname}` });
    return;
  }

  // Per-key rate limit, checked before anything else on /mcp - a rejected
  // request should cost the client nothing further, and the key it would
  // have used doesn't matter yet.
  const key = extractApiKey(req);
  const keys = apiKeys();
  // Keyed identity uses the key's fingerprint, never the key itself, so
  // nothing that reaches the audit log (or stderr) can carry the secret.
  // Without auth configured, the client IP is the identity. The socket's
  // remote address is used directly - trusting client-controlled
  // X-Forwarded-For here would let one client rotate a fresh rate-limit
  // window per request. Set MCP_HTTP_TRUST_PROXY=true only behind a
  // reverse proxy you control, which makes the proxy-set XFF first hop
  // the identity again.
  const trustProxy = (process.env.MCP_HTTP_TRUST_PROXY ?? "") === "true";
  const xff = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  const identity =
    keys.size > 0 && key
      ? `key:${fingerprintKey(key)}`
      : `ip:${(trustProxy && xff) || req.socket.remoteAddress || "unknown"}`;
  if (!checkRateLimit(identity)) {
    log("rate limit exceeded for", identity);
    writeAuditEntry({
      identity,
      key,
      method: req.method ?? "",
      outcome: "rejected",
      detail: "rate-limited",
    });
    res.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": String(Math.ceil(60)),
    });
    res.end(JSON.stringify({ error: "Too many requests - slow down and retry later." }));
    return;
  }

  if (!checkOrigin(req)) {
    writeAuditEntry({
      identity,
      key,
      method: req.method ?? "",
      outcome: "rejected",
      detail: "origin-not-allowed",
    });
    sendJson(res, 403, {
      error: `Origin "${req.headers.origin}" is not in MCP_HTTP_ALLOWED_ORIGINS`,
    });
    return;
  }
  if (!checkAuth(req)) {
    writeAuditEntry({
      identity,
      key,
      method: req.method ?? "",
      outcome: "rejected",
      detail: "unauthenticated",
    });
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer",
    });
    res.end(
      JSON.stringify({
        error:
          'Missing or invalid API key. Send it as "Authorization: Bearer <key>" or "X-API-Key: <key>".',
      }),
    );
    return;
  }

  switch (req.method) {
    case "POST":
      await handleMcpPost(req, res, { identity, key });
      return;
    case "GET":
      sendJson(res, 405, {
        error:
          "This server has no server-initiated notifications to stream, so it doesn't open a standalone SSE session via GET /mcp. Use POST /mcp for tool calls.",
      });
      return;
    case "DELETE":
      sendJson(res, 405, {
        error:
          "This server never issues a session id (every tool call is a fresh, independent request), so there's no session to terminate.",
      });
      return;
    default:
      res.writeHead(405, { Allow: "POST" });
      res.end();
  }
}

function main() {
  if (apiKeys().size === 0) {
    log(
      "WARNING: MCP_HTTP_API_KEYS is not set - this endpoint has no auth. Fine for 127.0.0.1; do not bind MCP_HTTP_HOST beyond localhost without setting it.",
    );
  }

  const server = createServer((req, res) => {
    void requestListener(req, res).catch((err) => {
      // Log the message only - the stack could carry internal paths and the
      // 500 body below is already a generic string (nothing is echoed back).
      log("unhandled error handling request:", err instanceof Error ? err.message : String(err));
      if (!res.headersSent) sendJson(res, 500, { error: "Internal server error" });
    });
  });

  server.listen(PORT, HOST, () => {
    log(
      `starting (streamable HTTP transport) on http://${HOST}:${PORT}/mcp, targeting Gateway at ${process.env.HEXFORGE_URL ?? "http://localhost:8080"}`,
    );
  });

  process.on("uncaughtException", (err) => {
    log("uncaught exception:", err);
  });
}

// Only start the server when this file is the process's entrypoint - so
// tests can import requestListener without a listener binding 8788.
const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) main();
