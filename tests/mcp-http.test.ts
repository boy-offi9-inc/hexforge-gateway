import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// http.ts's requestListener is exported specifically so this test can
// drive the /mcp request path end to end - rate limiting, origin and key
// checks, and the audit-log hooks - without binding a port. protocol.ts's
// gateway-client dependency is mocked (same approach as protocol.test.ts)
// so no real Gateway is needed.
vi.mock("../src/mcp-server/gateway-client.js", () => ({
  getOrCreateWorkspace: vi.fn(),
  listWorkspaces: vi.fn(),
  listKnowledge: vi.fn(),
  chat: vi.fn(),
  runJob: vi.fn(),
  listCapabilities: vi.fn(),
  listArtifacts: vi.fn(),
  listGraphEntities: vi.fn(),
  getGraphEntity: vi.fn(),
  listFindings: vi.fn(),
  createFinding: vi.fn(),
  updateFinding: vi.fn(),
  verifyFinding: vi.fn(),
  getReport: vi.fn(),
}));

import { requestListener } from "../src/mcp-server/http.js";
import { resetRateLimiterForTests } from "../src/mcp-server/auth-hardening.js";
import * as gateway from "../src/mcp-server/gateway-client.js";

const getOrCreateWorkspace = gateway.getOrCreateWorkspace as ReturnType<typeof vi.fn>;

const ENV_KEYS = [
  "MCP_HTTP_API_KEYS",
  "MCP_HTTP_ALLOWED_ORIGINS",
  "MCP_HTTP_RATE_LIMIT_MAX",
  "MCP_HTTP_RATE_LIMIT_WINDOW_MS",
  "MCP_HTTP_AUDIT_LOG",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const runJob = gateway.runJob as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetRateLimiterForTests();
  runJob.mockReset();
  getOrCreateWorkspace.mockReset();
  getOrCreateWorkspace.mockResolvedValue({
    id: "ws-default",
    name: "default",
    targetLabel: "default",
    status: "idle",
  });
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// Minimal request/response doubles: requestListener only reads a handful
// of IncomingMessage fields and only calls writeHead/end/setHeader on the
// response, so plain objects cover it - no server socket needed.
function fakeReq(opts: {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const listeners: Record<string, ((chunk?: unknown) => void)[]> = {};
  return {
    method: opts.method ?? "POST",
    url: opts.url ?? "/mcp",
    headers: opts.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
    on(event: string, cb: (chunk?: unknown) => void) {
      (listeners[event] ??= []).push(cb);
      return this as unknown as IncomingMessage;
    },
    // Deliver the body immediately for readBody().
    emitData(data: string) {
      for (const cb of listeners["data"] ?? []) cb(Buffer.from(data));
      for (const cb of listeners["end"] ?? []) cb();
    },
  } as unknown as IncomingMessage & { emitData(data: string): void };
}

function fakeRes() {
  const state = {
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    writeHead(code: number, headers?: Record<string, unknown>) {
      state.statusCode = code;
      state.headers = headers ?? {};
      return state as unknown as ServerResponse;
    },
    end(body?: string) {
      state.body += body ?? "";
      return state as unknown as ServerResponse;
    },
  };
  return state as unknown as ServerResponse & {
    statusCode: number;
    headers: Record<string, unknown>;
    body: string;
    writeHead: typeof state.writeHead;
    end: typeof state.end;
  };
}

async function postMcp(body: string, headers: Record<string, string> = {}) {
  const req = fakeReq({ method: "POST", url: "/mcp", headers });
  const res = fakeRes();
  const done = requestListener(req, res);
  // readBody is waiting on 'data'/'end' events; fire them right away.
  (req as unknown as { emitData(d: string): void }).emitData(body);
  await done;
  return res;
}

const pingBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
const toolCallBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "adb_shell", arguments: { command: "echo hi" } },
});

describe("mcp http transport - auth hardening wiring", () => {
  it("/health stays open and unauthenticated", async () => {
    process.env.MCP_HTTP_API_KEYS = "k1";
    const req = fakeReq({ method: "GET", url: "/health" });
    const res = fakeRes();
    await requestListener(req, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("rate limits per key and returns 429 with Retry-After", async () => {
    process.env.MCP_HTTP_API_KEYS = "k1,k2";
    process.env.MCP_HTTP_RATE_LIMIT_MAX = "2";
    const headers = { "x-api-key": "k1" };
    expect((await postMcp(pingBody, headers)).statusCode).toBe(200);
    expect((await postMcp(pingBody, headers)).statusCode).toBe(200);
    const third = await postMcp(pingBody, headers);
    expect(third.statusCode).toBe(429);
    expect((third.headers as Record<string, string>)["Retry-After"]).toBeDefined();
    // A different key still gets through - the limit is per key.
    expect((await postMcp(pingBody, { "x-api-key": "k2" })).statusCode).toBe(200);
  });

  it("rate limits by client IP when no auth is configured", async () => {
    process.env.MCP_HTTP_RATE_LIMIT_MAX = "1";
    expect((await postMcp(pingBody)).statusCode).toBe(200);
    expect((await postMcp(pingBody)).statusCode).toBe(429);
  });

  it("writes an audit entry for a successful tool call, with tool name and fingerprinted key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-http-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    try {
      process.env.MCP_HTTP_AUDIT_LOG = auditPath;
      process.env.MCP_HTTP_API_KEYS = "k1";
      runJob.mockResolvedValue({ id: "job1", status: "completed", result: { stdout: "hi" } });
      const res = await postMcp(toolCallBody, { "x-api-key": "k1" });
      expect(res.statusCode).toBe(200);
      const line = JSON.parse(readFileSync(auditPath, "utf8"));
      expect(line.outcome).toBe("ok");
      expect(line.tool).toBe("adb_shell");
      expect(line.key).toMatch(/^hmac:[0-9a-f]{16}$/);
      expect(JSON.stringify(line)).not.toContain("k1");
      expect(JSON.stringify(line)).not.toContain("echo hi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a rejected audit entry for an unauthenticated request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-http-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    try {
      process.env.MCP_HTTP_AUDIT_LOG = auditPath;
      process.env.MCP_HTTP_API_KEYS = "k1";
      const res = await postMcp(pingBody, { "x-api-key": "wrong" });
      expect(res.statusCode).toBe(401);
      const line = JSON.parse(readFileSync(auditPath, "utf8"));
      expect(line.outcome).toBe("rejected");
      expect(line.detail).toBe("unauthenticated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a rejected audit entry for a disallowed origin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-http-audit-"));
    const auditPath = join(dir, "audit.jsonl");
    try {
      process.env.MCP_HTTP_AUDIT_LOG = auditPath;
      process.env.MCP_HTTP_ALLOWED_ORIGINS = "https://good.example";
      const res = await postMcp(pingBody, { origin: "https://evil.example" });
      expect(res.statusCode).toBe(403);
      const line = JSON.parse(readFileSync(auditPath, "utf8"));
      expect(line.outcome).toBe("rejected");
      expect(line.detail).toBe("origin-not-allowed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still serves requests normally when the audit log is unset", async () => {
    runJob.mockResolvedValue({ stdout: "", exitCode: 0 });
    expect((await postMcp(pingBody)).statusCode).toBe(200);
  });
});
