/**
 * Auth hardening for the MCP Server Frontend's HTTP transport. Three
 * concerns that all sit in front of the same decision point - "should
 * this request to /mcp be served?" - kept in one module so http.ts reads
 * as routing only:
 *
 *  - per-key rate limiting: each API key (and, when no auth is
 *    configured, each client IP) gets its own fixed-window counter, so
 *    one noisy client can't exhaust the server for everyone. Configured
 *    with MCP_HTTP_RATE_LIMIT_MAX (requests per window, 0 = off) and
 *    MCP_HTTP_RATE_LIMIT_WINDOW_MS. Defaults: 120 per 60s - far above
 *    any interactive MCP session's tool-call rate, low enough that a
 *    runaway loop is visibly throttled. The window is fixed (not
 *    sliding), because a fixed window is O(1) memory per key and a
 *    slight burst at the boundary is harmless here.
 *
 *  - audit log: an append-only JSON Lines record of every /mcp request
 *    (method, tool name, key fingerprint, outcome), written on success
 *    or failure. Off by default (MCP_HTTP_AUDIT_LOG unset); when set,
 *    the value is a file path. Key values are never written - only a
 *    short SHA-256 fingerprint, and params are summarized, never
 *    included, so secrets that might appear in a tool call's arguments
 *    don't land in the log.
 *
 *  - nothing else. CORS/Origin checking already existed in http.ts
 *    (checkOrigin, MCP_HTTP_ALLOWED_ORIGINS); this module does not
 *    duplicate it.
 */

import { createHmac, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { log, type JsonRpcRequest } from "./protocol.js";

// Config is read lazily (per call, not at import) so tests can set env
// vars per test, and so a long-running process picks up intentional
// restarts cleanly.
export function rateLimitMax(): number {
  const n = Number(process.env.MCP_HTTP_RATE_LIMIT_MAX ?? 120);
  return Number.isFinite(n) && n >= 0 ? n : 120;
}
export function rateLimitWindowMs(): number {
  const n = Number(process.env.MCP_HTTP_RATE_LIMIT_WINDOW_MS ?? 60_000);
  // a NaN window would make `now - start >= NaN` false forever, bricking
  // every identity once it hits max requests - fall back to the default
  return Number.isFinite(n) && n > 0 ? n : 60_000;
}
function auditLogPath(): string {
  return process.env.MCP_HTTP_AUDIT_LOG ?? "";
}

// key/identity -> { windowStart, count }. Fixed-window counter per
// identity; when an unauthenticated deployment faces an identity flood
// (rotated client IPs) the map is capped by evicting the oldest inserted
// entries - bounded memory, at the cost of the oldest identities' windows.
const MAX_RATE_LIMIT_IDENTITIES = 10_000;
const counters = new Map<string, { windowStart: number; count: number }>();

export function resetRateLimiterForTests() {
  counters.clear();
}

/** Per-boot random HMAC key: fingerprints are consistent within one
 * Gateway process, differ across restarts (audit-log lines from previous
 * boots can't be correlated to new ones - acceptable for a single-boot
 * audit trail), and the keyed digest resists offline recovery of the key. */
const FINGERPRINT_SECRET = randomBytes(32);

/** Short, non-reversible fingerprint of an API key for the audit log. */
export function fingerprintKey(key: string | null | undefined): string | null {
  if (!key) return null;
  return "hmac:" + createHmac("sha256", FINGERPRINT_SECRET).update(key).digest("hex").slice(0, 16);
}

/** What a tool call's method name was, for the audit log - nothing more. */
export function toolNameOf(parsed: JsonRpcRequest): string | undefined {
  return parsed.method === "tools/call"
    ? ((parsed.params?.["name"] as string | undefined) ?? undefined)
    : undefined;
}

/**
 * True if this identity is under its rate limit for the current window.
 * The first request of a new window sets the window start; when the
 * window expires the counter restarts from 1 (this request counts).
 */
export function checkRateLimit(identity: string): boolean {
  const max = rateLimitMax();
  if (max <= 0) return true; // explicitly disabled
  const now = Date.now();
  let entry = counters.get(identity);
  if (!entry || now - entry.windowStart >= rateLimitWindowMs()) {
    if (!counters.has(identity) && counters.size >= MAX_RATE_LIMIT_IDENTITIES) {
      // evict the oldest inserted identity (Map preserves insertion order)
      const oldest = counters.keys().next().value;
      if (oldest !== undefined) counters.delete(oldest);
    }
    counters.set(identity, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= max;
}

let auditFileReady = false;
function ensureAuditFile(path: string) {
  if (auditFileReady) return;
  mkdirSync(dirname(path), { recursive: true });
  auditFileReady = true;
}

/**
 * Appends one audit record. Never throws - an audit failure must not
 * take down the request path; it logs to stderr instead. The record
 * contains no arguments (params), no raw keys, no client-controlled
 * strings beyond the tool name and a short error code - only enough to
 * answer "who called what, when, and did it work".
 */
export function writeAuditEntry(entry: {
  identity: string;
  key: string | null | undefined;
  method: string;
  tool?: string;
  outcome: "ok" | "error" | "rejected";
  detail?: string;
}) {
  const path = auditLogPath();
  if (!path) return;
  const record = {
    ts: new Date().toISOString(),
    identity: entry.identity,
    key: fingerprintKey(entry.key),
    method: entry.method,
    ...(entry.tool !== undefined ? { tool: entry.tool } : {}),
    outcome: entry.outcome,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
  };
  try {
    const absPath = resolve(path);
    ensureAuditFile(absPath);
    appendFileSync(absPath, JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (err) {
    log("audit log write failed:", err instanceof Error ? err.message : String(err));
  }
}
