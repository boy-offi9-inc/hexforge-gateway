import type { McpTask } from "../../../core/types.js";

/**
 * Generic client for the Model Context Protocol's "Streamable HTTP"
 * transport, plus convenience operations tailored to MT Manager's "APK MCP"
 * tool surface (mt_apk_*). Works with any MCP server, but the named
 * operations below assume MT's tool names and required-field conventions
 * (MT's schemas require every field to be present, even trivial ones like
 * editSessionId="" or startColumn=0 - the helpers below fill those in).
 *
 * Supported operations (set via task.operation):
 *   - "list_tools"           -> generic: lists all tools the server exposes
 *   - "call_tool"             -> generic escape hatch: { tool, arguments }
 *   - "list_available_apks"   -> mt_apk_list_available_apks
 *   - "open"                  -> mt_apk_workspace_open (older MT: mt_apk_open)
 *   - "list"                  -> mt_apk_list (zip_entries | dex_classes | resource_table)
 *   - "outline_class"         -> mt_apk_dex_read_class_outline (older MT: mt_apk_outline_class)
 *   - "read_text"             -> mt_apk_read_text
 *   - "search"                -> mt_apk_search
 *   - "close"                 -> mt_apk_workspace_delete (older MT: mt_apk_close)
 *
 * MT has renamed tools between versions, so the three operations above carry
 * a list of names, newest first, and use whichever one MT's `tools/list`
 * reports (see TOOL_NAMES and resolveToolName).
 *
 * `close` is mt_apk_workspace_delete on current MT, which deletes the workspace
 * and everything saved under it - so it refuses to delete a saved
 * (non-temporary) workspace unless the payload says `force: true`.
 *
 * Anything involving edits, builds, or the file and zip tools (mt_apk_*edit*,
 * mt_apk_patch_*, mt_apk_build, mt_file_*, mt_zip_*) is intentionally NOT
 * wrapped with a convenience operation - those mutate APKs and files, so
 * callers should use "call_tool" directly and pass MT's full argument shape
 * explicitly. That capability should only be pointed at apps and files you own
 * or are authorized to modify. docs/MT_TOOLS.md lists every tool.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8787/mcp";
const PROTOCOL_VERSION = "2025-03-26";

// initSession always uses id 1 for "initialize". Every request after that
// - list_tools, and each callTool() - needs its own unique id so the SSE
// reader in sendMcpMessage() matches the right response back to the right
// request; a shared hardcoded id only "worked" because today's handler
// makes exactly one such call per task. A monotonically increasing counter
// keeps that true even if a future operation ever needs to chain more than
// one call within a single apkMcpHandler invocation.
let nextRequestId = 2;
function newRequestId(): number {
  return nextRequestId++;
}

interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

async function sendMcpMessage(
  baseUrl: string,
  message: JsonRpcMessage,
  sessionId?: string,
): Promise<{ result?: any; error?: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });

  const returnedSessionId = res.headers.get("mcp-session-id") ?? undefined;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`MCP server responded ${res.status}: ${text.slice(0, 500)}`);
  }

  // Notifications get no body back.
  if (message.id === undefined) {
    return { sessionId: returnedSessionId };
  }

  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    // The stream may stay open indefinitely for future server pushes, so we
    // can't wait for it to close (res.text() would hang forever). Read
    // incrementally and stop as soon as we see a complete JSON-RPC message
    // matching this request's id.
    if (!res.body) throw new Error("MCP server returned an event-stream with no body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const timeoutMs = 30_000;
    const deadline = Date.now() + timeoutMs;

    try {
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const evt of events) {
          const dataLine = evt.split("\n").find((line) => line.startsWith("data:"));
          if (!dataLine) continue;

          const jsonStr = dataLine.slice(5).trim();
          let parsed: any;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (parsed.id === message.id) {
            await reader.cancel().catch(() => {});
            return {
              result: parsed.result,
              error: parsed.error,
              sessionId: returnedSessionId,
            };
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    throw new Error(
      `Timed out waiting for MCP response to "${message.method}" after ${timeoutMs}ms`,
    );
  }

  const parsed = await res.json();
  return {
    result: parsed.result,
    error: parsed.error,
    sessionId: returnedSessionId,
  };
}

async function initSession(baseUrl: string): Promise<string | undefined> {
  const initResult = await sendMcpMessage(baseUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "hexforge-gateway", version: "0.1.0" },
    },
  });

  if (initResult.error) {
    throw new Error(`MCP initialize failed: ${JSON.stringify(initResult.error)}`);
  }

  const sessionId = initResult.sessionId;
  await sendMcpMessage(baseUrl, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return sessionId;
}

/**
 * Tool call results may arrive as `structuredContent` (when the tool
 * declares an outputSchema, as MT's tools all do), as a `content` array
 * with a text block containing JSON, or occasionally as a raw object.
 * This normalizes all of those into MT's {ok, data, error, nextActions}
 * shape (or whatever the tool actually returns) so callers get clean data
 * instead of having to unwrap MCP's transport envelope themselves.
 */
function unwrapToolResult(result: any): unknown {
  if (result && typeof result === "object" && "structuredContent" in result) {
    return result.structuredContent;
  }
  if (Array.isArray(result?.content)) {
    const textBlock = result.content.find((c: any) => c?.type === "text");
    if (textBlock?.text) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return textBlock.text;
      }
    }
  }
  return result;
}

async function callTool(
  baseUrl: string,
  sessionId: string | undefined,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { result, error } = await sendMcpMessage(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: newRequestId(),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    sessionId,
  );
  if (error) throw new Error(`${toolName} failed: ${JSON.stringify(error)}`);

  const payload = unwrapToolResult(result);

  // isError is a transport-level flag distinct from the tool's own
  // ok:false business responses; only transport-level errors are worth
  // throwing on here, since ok:false payloads (e.g. RESOURCE_NOT_FOUND)
  // are informative results, not agent failures - the caller/AI driving
  // this can read payload.error and payload.nextActions to decide what to
  // do next.
  if (result?.isError && typeof payload !== "object") {
    throw new Error(`${toolName} reported an error: ${JSON.stringify(payload)}`);
  }

  return payload;
}

/**
 * MT Manager's tool names for the operations it has renamed, newest first.
 * Operations not listed here (list_available_apks, list, read_text, search)
 * have kept their names and are called directly.
 */
export const TOOL_NAMES = {
  open: ["mt_apk_workspace_open", "mt_apk_open"],
  outline_class: ["mt_apk_dex_read_class_outline", "mt_apk_outline_class"],
  close: ["mt_apk_workspace_delete", "mt_apk_close"],
} as const;

const TOOL_LIST_TTL_MS = 60_000;
const toolLists = new Map<string, { names: Set<string>; at: number }>();

/** Forgets the cached tool lists. Only tests need this. */
export function clearToolListCache(): void {
  toolLists.clear();
}

/** The first of `candidates` that `available` contains, or undefined. */
export function pickToolName(
  candidates: readonly string[],
  available: ReadonlySet<string>,
): string | undefined {
  return candidates.find((name) => available.has(name));
}

/** The tool names MT offers, from `tools/list`, remembered for a minute per server. */
async function availableTools(
  baseUrl: string,
  sessionId: string | undefined,
): Promise<Set<string> | undefined> {
  const cached = toolLists.get(baseUrl);
  if (cached && Date.now() - cached.at < TOOL_LIST_TTL_MS) return cached.names;

  const { result, error } = await sendMcpMessage(
    baseUrl,
    { jsonrpc: "2.0", id: newRequestId(), method: "tools/list" },
    sessionId,
  );
  if (error || !Array.isArray(result?.tools)) return undefined;

  const names = new Set<string>(
    result.tools
      .map((t: { name?: unknown }) => t?.name)
      .filter((n: unknown) => typeof n === "string"),
  );
  toolLists.set(baseUrl, { names, at: Date.now() });
  return names;
}

/**
 * Picks the tool name this MT version uses. If `tools/list` can't be read the
 * newest name is tried; if it can and none of the candidates is there, the
 * error says which names were tried and what MT does offer, instead of
 * surfacing a bare "unknown tool".
 */
async function resolveToolName(
  baseUrl: string,
  sessionId: string | undefined,
  operation: string,
  candidates: readonly string[],
): Promise<string> {
  const available = await availableTools(baseUrl, sessionId);
  if (!available) return candidates[0] as string;

  const picked = pickToolName(candidates, available);
  if (picked) return picked;

  const offered = [...available].filter((n) => n.startsWith("mt_apk_")).sort();
  const examples = offered.length > 0 ? `, e.g. ${offered.slice(0, 8).join(", ")}` : "";
  throw new Error(
    `This MT Manager has no tool for "${operation}": looked for ${candidates.join(" or ")}. ` +
      `It offers ${offered.length} mt_apk_* tools${examples} - ` +
      `run the list_tools operation for the full list, and use call_tool for anything newer.`,
  );
}

/**
 * Closing a workspace is mt_apk_workspace_delete on current MT, which deletes
 * it and all its edit sessions. MT says to keep ordinary (non-temporary)
 * workspaces for reuse, so refuse to delete one unless the caller said force.
 * If MT can't say whether it's saved, refuse too.
 */
async function assertSafeToDelete(
  baseUrl: string,
  sessionId: string | undefined,
  workspaceId: string,
): Promise<void> {
  let saved: unknown;
  try {
    saved = await callTool(baseUrl, sessionId, "mt_apk_workspace_list", {});
  } catch (err) {
    throw new Error(
      `close would delete workspace ${workspaceId}, and MT couldn't confirm it is temporary (${
        err instanceof Error ? err.message : String(err)
      }). Pass "force": true to delete it anyway.`,
    );
  }
  const items = (saved as { data?: { items?: { workspaceId?: string }[] } })?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(
      `close would delete workspace ${workspaceId}, and MT's saved-workspace list wasn't readable. Pass "force": true to delete it anyway.`,
    );
  }
  if (items.some((item) => item?.workspaceId === workspaceId)) {
    throw new Error(
      `Workspace ${workspaceId} is a saved (non-temporary) workspace; close would permanently delete it and its edit sessions. Pass "force": true to delete it anyway, or open APKs with "temporary": true when you only need them for a moment.`,
    );
  }
}

interface ApkMcpPayload {
  baseUrl?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  // convenience-operation fields
  path?: string;
  temporary?: boolean;
  workspaceId?: string;
  force?: boolean; // close: allow deleting a saved (non-temporary) workspace
  editSessionId?: string;
  view?: "zip_entries" | "dex_classes" | "resource_table";
  prefix?: string;
  limit?: number;
  locator?: string;
  target?: string;
  query?: string;
  queryType?: "literal" | "regex";
  caseSensitive?: boolean;
  matchMode?: "contains" | "exact";
}

export async function apkMcpHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as ApkMcpPayload;
  const baseUrl = payload.baseUrl ?? DEFAULT_BASE_URL;

  let sessionId: string | undefined;
  try {
    sessionId = await initSession(baseUrl);
  } catch (err) {
    throw new Error(
      `Could not connect to MCP server at ${baseUrl}. Make sure the APK MCP service is running and reachable from this device/network. (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  switch (task.operation) {
    case "list_tools": {
      const { result, error } = await sendMcpMessage(
        baseUrl,
        { jsonrpc: "2.0", id: newRequestId(), method: "tools/list" },
        sessionId,
      );
      if (error) throw new Error(`tools/list failed: ${JSON.stringify(error)}`);
      return result;
    }

    case "call_tool": {
      if (!payload.tool) throw new Error('call_tool requires a "tool" name in the payload');
      return callTool(baseUrl, sessionId, payload.tool, payload.arguments ?? {});
    }

    case "list_available_apks": {
      return callTool(baseUrl, sessionId, "mt_apk_list_available_apks", {
        prefix: payload.prefix ?? "",
        limit: payload.limit ?? 50,
      });
    }

    case "open": {
      if (!payload.path) {
        throw new Error(
          'open requires a "path": a Home-relative APK path from list_available_apks, "mt://current-apk", "mt://workspace/<id>" (with temporary: false) to reopen a saved workspace, or an absolute path MT allows',
        );
      }
      const tool = await resolveToolName(baseUrl, sessionId, "open", TOOL_NAMES.open);
      return callTool(baseUrl, sessionId, tool, {
        path: payload.path,
        temporary: payload.temporary ?? false,
      });
    }

    case "list": {
      if (!payload.workspaceId)
        throw new Error('list requires "workspaceId" from a prior "open" call');
      return callTool(baseUrl, sessionId, "mt_apk_list", {
        workspaceId: payload.workspaceId,
        editSessionId: payload.editSessionId ?? "",
        view: payload.view ?? "zip_entries",
        prefix: payload.prefix ?? "",
        limit: payload.limit ?? 200,
      });
    }

    case "outline_class": {
      if (!payload.workspaceId || !payload.locator) {
        throw new Error(
          'outline_class requires "workspaceId" and a "locator" like dex_class:Lcom/example/Foo;',
        );
      }
      const tool = await resolveToolName(
        baseUrl,
        sessionId,
        "outline_class",
        TOOL_NAMES.outline_class,
      );
      return callTool(baseUrl, sessionId, tool, {
        workspaceId: payload.workspaceId,
        editSessionId: payload.editSessionId ?? "",
        locator: payload.locator,
        limit: payload.limit ?? 200,
      });
    }

    case "read_text": {
      if (!payload.workspaceId || !payload.locator) {
        throw new Error(
          'read_text requires "workspaceId" and a "locator" (zip_entry:, axml:, dex_class:, dex_method:, or dex_field:)',
        );
      }
      return callTool(baseUrl, sessionId, "mt_apk_read_text", {
        workspaceId: payload.workspaceId,
        editSessionId: payload.editSessionId ?? "",
        locator: payload.locator,
        limit: payload.limit ?? 500,
        maxChars: 49152,
        startLine: 0,
        startColumn: 0,
      });
    }

    case "search": {
      if (!payload.workspaceId || !payload.query) {
        throw new Error('search requires "workspaceId" and a "query"');
      }
      return callTool(baseUrl, sessionId, "mt_apk_search", {
        workspaceId: payload.workspaceId,
        editSessionId: payload.editSessionId ?? "",
        target: payload.target ?? "overview",
        query: payload.query,
        queryType: payload.queryType ?? "literal",
        caseSensitive: payload.caseSensitive ?? false,
        matchMode: payload.matchMode ?? "contains",
        prefix: payload.prefix ?? "",
        includeMatchOffsets: false,
        limit: payload.limit ?? 50,
        snippetMaxChars: 240,
      });
    }

    case "close": {
      if (!payload.workspaceId) throw new Error('close requires "workspaceId"');
      const tool = await resolveToolName(baseUrl, sessionId, "close", TOOL_NAMES.close);
      if (tool === "mt_apk_workspace_delete" && !payload.force) {
        await assertSafeToDelete(baseUrl, sessionId, payload.workspaceId);
      }
      return callTool(baseUrl, sessionId, tool, {
        workspaceId: payload.workspaceId,
      });
    }

    default:
      throw new Error(
        `Unsupported apkmcp operation "${task.operation}". Supported: list_tools, call_tool, list_available_apks, open, list, outline_class, read_text, search, close`,
      );
  }
}
