import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkRateLimit,
  fingerprintKey,
  rateLimitMax,
  resetRateLimiterForTests,
  toolNameOf,
  writeAuditEntry,
} from "../src/mcp-server/auth-hardening.js";

// auth-hardening.ts reads its configuration lazily from env, so tests can
// set MCP_HTTP_* per test with plain process.env writes. The rate-limit
// counters are process-wide state, reset between tests.

const ENV_KEYS = [
  "MCP_HTTP_RATE_LIMIT_MAX",
  "MCP_HTTP_RATE_LIMIT_WINDOW_MS",
  "MCP_HTTP_AUDIT_LOG",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function setEnv(k: (typeof ENV_KEYS)[number], v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

afterEach(() => {
  for (const k of ENV_KEYS) setEnv(k, savedEnv[k]);
  resetRateLimiterForTests();
});

describe("rate limiting", () => {
  it("defaults to 120 per window", () => {
    expect(rateLimitMax()).toBe(120);
  });

  it("allows requests up to the limit, then blocks", () => {
    setEnv("MCP_HTTP_RATE_LIMIT_MAX", "3");
    const identity = "key:test-key";
    expect(checkRateLimit(identity)).toBe(true);
    expect(checkRateLimit(identity)).toBe(true);
    expect(checkRateLimit(identity)).toBe(true);
    expect(checkRateLimit(identity)).toBe(false);
    expect(checkRateLimit(identity)).toBe(false);
  });

  it("tracks identities independently", () => {
    setEnv("MCP_HTTP_RATE_LIMIT_MAX", "1");
    expect(checkRateLimit("key:a")).toBe(true);
    expect(checkRateLimit("key:a")).toBe(false);
    expect(checkRateLimit("key:b")).toBe(true);
  });

  it("a new window resets the counter", () => {
    setEnv("MCP_HTTP_RATE_LIMIT_MAX", "1");
    setEnv("MCP_HTTP_RATE_LIMIT_WINDOW_MS", "50");
    const identity = "key:windowed";
    expect(checkRateLimit(identity)).toBe(true);
    expect(checkRateLimit(identity)).toBe(false);
    // Fixed window: once 50ms have passed since the window started, the
    // next request opens a new one. Poll rather than sleep a fixed time.
    const deadline = Date.now() + 2_000;
    let reopened = false;
    while (Date.now() < deadline) {
      if (checkRateLimit(identity)) {
        reopened = true;
        break;
      }
    }
    expect(reopened).toBe(true);
  });

  it("a non-positive max disables limiting entirely", () => {
    setEnv("MCP_HTTP_RATE_LIMIT_MAX", "0");
    for (let i = 0; i < 50; i++) expect(checkRateLimit("key:off")).toBe(true);
  });
});

describe("fingerprintKey", () => {
  it("returns null for a missing key", () => {
    expect(fingerprintKey(undefined)).toBeNull();
    expect(fingerprintKey(null)).toBeNull();
    expect(fingerprintKey("")).toBeNull();
  });

  it("is deterministic, short, and does not contain the key", () => {
    const fp = fingerprintKey("super-secret-key-value");
    expect(fp).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(fp).toBe(fingerprintKey("super-secret-key-value"));
    expect(fp).not.toContain("super-secret");
  });
});

describe("toolNameOf", () => {
  it("extracts the tool name from tools/call params", () => {
    expect(
      toolNameOf({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } }),
    ).toBe("read_file");
  });

  it("returns undefined for other methods or missing names", () => {
    expect(toolNameOf({ jsonrpc: "2.0", id: 1, method: "tools/list" })).toBeUndefined();
    expect(toolNameOf({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} })).toBeUndefined();
  });
});

describe("audit log", () => {
  it("is a no-op when MCP_HTTP_AUDIT_LOG is unset (off by default)", () => {
    setEnv("MCP_HTTP_AUDIT_LOG", undefined);
    expect(() =>
      writeAuditEntry({ identity: "ip:1.2.3.4", key: "k", method: "POST", outcome: "ok" }),
    ).not.toThrow();
  });

  it("appends one JSON line per entry with a fingerprinted key, never the raw key", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-audit-"));
    const auditPath = join(dir, "logs", "audit.jsonl");
    try {
      setEnv("MCP_HTTP_AUDIT_LOG", auditPath);
      writeAuditEntry({
        identity: "key:abc",
        key: "secret-value",
        method: "POST",
        tool: "read_file",
        outcome: "ok",
      });
      writeAuditEntry({
        identity: "key:abc",
        key: "secret-value",
        method: "POST",
        tool: "adb_shell",
        outcome: "error",
        detail: "tool failed",
      });

      const lines = readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines).toHaveLength(2);
      expect(lines[0].identity).toBe("key:abc");
      expect(lines[0].key).toMatch(/^sha256:[0-9a-f]{16}$/);
      expect(JSON.stringify(lines)).not.toContain("secret-value");
      expect(lines[0].tool).toBe("read_file");
      expect(lines[0].outcome).toBe("ok");
      expect(lines[1].outcome).toBe("error");
      expect(lines[1].detail).toBe("tool failed");
      expect(typeof lines[0].ts).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates parent directories and does not throw on an unwritable path", () => {
    setEnv("MCP_HTTP_AUDIT_LOG", "/proc/definitely-not-writable/audit.jsonl");
    expect(() =>
      writeAuditEntry({ identity: "ip:1", key: null, method: "GET", outcome: "rejected" }),
    ).not.toThrow();
  });

  it("records a rejected entry with a detail code", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    try {
      setEnv("MCP_HTTP_AUDIT_LOG", auditPath);
      writeAuditEntry({
        identity: "ip:9.9.9.9",
        key: null,
        method: "POST",
        outcome: "rejected",
        detail: "rate-limited",
      });
      const line = JSON.parse(readFileSync(auditPath, "utf8"));
      expect(line.outcome).toBe("rejected");
      expect(line.detail).toBe("rate-limited");
      expect(line.key).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
