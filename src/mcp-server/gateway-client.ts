/**
 * Thin HTTP client the MCP server frontend uses to talk to an already-
 * running HexForge Gateway. Deliberately doesn't reimplement any
 * business logic (retries, workflow sequencing, workspace resolution) -
 * all of that already exists in the Gateway itself and stays there. This
 * file's only job is translating an MCP tool call into the right HTTP
 * request and waiting for a settled result, the same way scripts/hf.sh
 * and scripts/smoke-test.sh already do from the outside.
 *
 * Same env vars as those scripts: HEXFORGE_URL (default localhost:8080),
 * HEXFORGE_API_KEY (only needed if the Gateway has AUTH_ENABLED=true).
 */

const BASE_URL = process.env.HEXFORGE_URL ?? "http://localhost:8080";
const API_KEY = process.env.HEXFORGE_API_KEY;

function authHeaders(): Record<string, string> {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error ?? parsed);
    } catch {
      // not JSON, use the raw text
    }
    throw new Error(`Gateway ${method} ${path} -> ${res.status}: ${message || res.statusText}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Workspace {
  id: string;
  name: string;
  targetLabel: string;
  status: string;
}

export interface Job {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
}

export interface Workflow {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  steps: { status: string; result?: unknown; error?: string }[];
  error?: string;
}

/** Get-or-create a workspace by name - every tool call resolves its `workspace` argument through this. */
export async function getOrCreateWorkspace(name: string, targetLabel = name): Promise<Workspace> {
  return request<Workspace>("PUT", `/workspaces/by-name/${encodeURIComponent(name)}`, { targetLabel });
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>("GET", "/workspaces");
}

export async function listKnowledge(workspaceId: string, type?: string): Promise<unknown[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : "";
  return request<unknown[]>("GET", `/workspaces/${workspaceId}/knowledge${qs}`);
}

export async function chat(workspaceId: string, message: string): Promise<{ reply: string; entryId: string }> {
  return request("POST", `/workspaces/${workspaceId}/chat`, { message });
}

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120_000; // 2 minutes - a jadx decompile of a large APK can genuinely take a while

/**
 * Submits a job and blocks until it settles (completed/failed) or the
 * poll timeout is hit. MCP tool calls are expected to behave like a
 * normal function call - return a real result, not a "queued" status the
 * caller has to check back on - so the waiting happens here rather than
 * being pushed onto whoever's driving the MCP client.
 */
export async function runJob(
  workspaceId: string,
  agent: string,
  operation: string,
  payload: Record<string, unknown>,
  maxAttempts?: number
): Promise<Job> {
  const job = await request<Job & { id: string }>("POST", `/workspaces/${workspaceId}/jobs`, {
    agent,
    operation,
    payload,
    maxAttempts,
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let current = job;
  while (current.status !== "completed" && current.status !== "failed") {
    if (Date.now() > deadline) {
      throw new Error(
        `Job ${job.id} (${agent}:${operation}) didn't settle within ${POLL_TIMEOUT_MS / 1000}s - it may still be ` +
          `running. Check "GET /jobs/${job.id}" directly for its current state.`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    current = await request<Job>("GET", `/jobs/${job.id}`);
  }
  return current;
}
