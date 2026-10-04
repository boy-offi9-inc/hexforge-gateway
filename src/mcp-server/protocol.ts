/**
 * Transport-agnostic MCP protocol logic: JSON-RPC method dispatch and tool
 * execution. Neither stdio (index.ts) nor Streamable HTTP (http.ts) know
 * anything about tools, workspaces, or the Gateway - they only know how to
 * get bytes in and a JSON-RPC message object out. Keeping that split means
 * adding a transport is wiring, not a second copy of the protocol.
 */

import { ALL_TOOL_DEFINITIONS, AGENT_TOOLS } from "./tools.js";
import * as gateway from "./gateway-client.js";

// Protocol versions this server actually implements, newest first. A tools-only
// server behaves identically across these two: tools/list, tools/call, ping and
// the initialize handshake didn't change between them.
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];
export const PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

// Per the MCP spec's version negotiation: if the client asks for a version we
// support, answer with that same version; otherwise answer with the newest one
// we do support and let the client decide whether it can work with it. Never
// echo back a version we don't implement - a client that checks the reply
// against its own supported list (mcp-proxy does) will refuse the connection.
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : PROTOCOL_VERSION;
}
export const SERVER_NAME = "hexforge-gateway";
export const SERVER_VERSION = "0.1.0";
const DEFAULT_WORKSPACE = "default";

export function log(...args: unknown[]) {
  // Every transport's entrypoint must send this to stderr, never stdout/
  // an HTTP response body - see index.ts's file-level comment for why
  // that's an absolute rule for the stdio transport specifically.
  console.error("[hexforge-mcp]", ...args);
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export type JsonRpcResponse = Record<string, unknown>;

function resultMessage(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorMessage(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Tool results below are JSON.stringify()'d *without* pretty-printing
// (no `null, 2`) - this text goes straight into an AI model's context on
// every single tool call, not a terminal a human is reading. The 2-space
// indentation/newlines a pretty-print adds are pure token overhead here -
// measured ~33% fewer characters compact vs pretty on a representative
// result shape. Don't add pretty-printing back for "readability" without
// remembering who's actually reading this.
function toolTextResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

/**
 * Runs a tool call and always returns a normal MCP tool result, even on
 * failure - per the MCP convention, a tool execution error (a bad path,
 * jadx not installed, a device unreachable) is reported as
 * `isError: true` inside a successful JSON-RPC response, not as a
 * JSON-RPC-level error. That distinction matters: a JSON-RPC error means
 * "the protocol call itself was malformed"; isError means "the tool ran
 * and it didn't work" - the model needs to see the latter to react to it
 * (try a different path, ask the user to install something), whereas a
 * malformed call is a client bug, not something to reason about.
 */
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown[]; isError: boolean }> {
  const workspaceName = (args.workspace as string | undefined)?.trim() || DEFAULT_WORKSPACE;

  try {
    // Meta tools first - bespoke logic, not a straight agent-job mapping.
    switch (name) {
      case "list_workspaces": {
        const workspaces = await gateway.listWorkspaces();
        return toolTextResult(JSON.stringify(workspaces));
      }
      case "get_or_create_workspace": {
        const workspaceArg = args.name as string;
        if (!workspaceArg) return toolTextResult('"name" is required', true);
        const ws = await gateway.getOrCreateWorkspace(
          workspaceArg,
          (args.targetLabel as string) || workspaceArg,
        );
        return toolTextResult(JSON.stringify(ws));
      }
      case "list_knowledge": {
        const ws = await gateway.getOrCreateWorkspace(workspaceName);
        const entries = await gateway.listKnowledge(ws.id, args.type as string | undefined);
        return toolTextResult(JSON.stringify(entries));
      }
      case "get_inbox_apks": {
        const ws = await gateway.getOrCreateWorkspace(workspaceName);
        const apks = await gateway.listInboxApks(ws.id);
        return toolTextResult(JSON.stringify(apks));
      }
      case "chat_with_workspace": {
        const message = args.message as string;
        if (!message) return toolTextResult('"message" is required', true);
        const ws = await gateway.getOrCreateWorkspace(workspaceName);
        const result = await gateway.chat(ws.id, message);
        return toolTextResult(result.reply);
      }
    }

    // Everything else: look up the {agent, operation} this tool maps to,
    // strip the meta fields (workspace, maxAttempts) out of the args, and
    // whatever's left is the job payload.
    const spec = AGENT_TOOLS.find((t) => t.name === name);
    if (!spec) {
      return toolTextResult(`Unknown tool "${name}"`, true);
    }

    const { workspace: _workspace, maxAttempts, ...payload } = args;
    const ws = await gateway.getOrCreateWorkspace(workspaceName);
    const job = await gateway.runJob(
      ws.id,
      spec.agent,
      spec.operation,
      payload,
      maxAttempts as number | undefined,
    );

    if (job.status === "failed") {
      return toolTextResult(job.error ?? "Job failed with no error message", true);
    }
    return toolTextResult(JSON.stringify(job.result));
  } catch (err) {
    return toolTextResult(err instanceof Error ? err.message : String(err), true);
  }
}

/**
 * Dispatches one JSON-RPC message and returns the response to send, or
 * `undefined` for a notification (no response is ever sent for those,
 * per JSON-RPC - the caller shouldn't write anything to the wire in that
 * case, not even an empty message).
 */
export async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  const { id, method, params } = req;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case "initialize": {
        if (isNotification) return undefined;
        return resultMessage(id, {
          protocolVersion: negotiateProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }

      case "notifications/initialized":
        // Pure notification, no response expected - just acknowledges the client is ready.
        return undefined;

      case "ping": {
        if (isNotification) return undefined;
        return resultMessage(id, {});
      }

      case "tools/list": {
        if (isNotification) return undefined;
        return resultMessage(id, { tools: ALL_TOOL_DEFINITIONS });
      }

      case "tools/call": {
        if (isNotification) return undefined;
        const toolName = params?.name as string | undefined;
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        if (!toolName) {
          return errorMessage(id, -32602, 'Missing "name" in tools/call params');
        }
        const result = await callTool(toolName, args);
        return resultMessage(id, result);
      }

      default:
        if (isNotification) {
          log(`ignoring unknown notification "${method}"`);
          return undefined;
        }
        return errorMessage(id, -32601, `Method not found: "${method}"`);
    }
  } catch (err) {
    log(`unhandled error in ${method}:`, err);
    if (isNotification) return undefined;
    return errorMessage(id, -32603, err instanceof Error ? err.message : String(err));
  }
}
