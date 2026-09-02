#!/usr/bin/env node
/**
 * HexForge's MCP server frontend. Speaks the Model Context Protocol over
 * stdio - the transport Claude Desktop, Claude Code, and most other MCP
 * clients spawn a server with - so any of them can register HexForge's
 * agents as native tools, without needing to know the Gateway has its
 * own REST API underneath.
 *
 * This is a thin protocol adapter, not a reimplementation: every tool
 * call turns into an HTTP request to an already-running Gateway (see
 * gateway-client.ts) and reuses all of its actual logic - retries via the
 * Job Engine, workspace resolution, everything. The Gateway needs to be
 * running separately; this process doesn't start one.
 *
 * ABSOLUTE RULE: nothing but framed JSON-RPC messages may ever reach
 * stdout. A stray console.log, an uncaught promise rejection printed by
 * Node, a dependency that logs to stdout - any of it corrupts the
 * message stream for the client reading it. All logging in this file
 * goes to stderr via `log()` below, on purpose, everywhere.
 *
 * Usage (after `npm run build`):
 *   node dist/mcp-server/index.js
 * Point your MCP client's config at that command. Set HEXFORGE_URL /
 * HEXFORGE_API_KEY in the environment the client launches it with if the
 * Gateway isn't on the default localhost:8080 or has auth enabled.
 */

import { ALL_TOOL_DEFINITIONS, AGENT_TOOLS } from "./tools.js";
import * as gateway from "./gateway-client.js";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "hexforge-gateway";
const SERVER_VERSION = "0.1.0";
const DEFAULT_WORKSPACE = "default";

function log(...args: unknown[]) {
  console.error("[hexforge-mcp]", ...args);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function writeMessage(message: Record<string, unknown>) {
  // The one and only thing allowed to touch stdout in this whole process.
  process.stdout.write(JSON.stringify(message) + "\n");
}

function respondResult(id: number | string, result: unknown) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function respondError(id: number | string, code: number, message: string) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
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
async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError: boolean }> {
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
        const ws = await gateway.getOrCreateWorkspace(workspaceArg, (args.targetLabel as string) || workspaceArg);
        return toolTextResult(JSON.stringify(ws));
      }
      case "list_knowledge": {
        const ws = await gateway.getOrCreateWorkspace(workspaceName);
        const entries = await gateway.listKnowledge(ws.id, args.type as string | undefined);
        return toolTextResult(JSON.stringify(entries));
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
    const job = await gateway.runJob(ws.id, spec.agent, spec.operation, payload, maxAttempts as number | undefined);

    if (job.status === "failed") {
      return toolTextResult(job.error ?? "Job failed with no error message", true);
    }
    return toolTextResult(JSON.stringify(job.result));
  } catch (err) {
    return toolTextResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function handleRequest(req: JsonRpcRequest) {
  const { id, method, params } = req;
  const isNotification = id === undefined;

  try {
    switch (method) {
      case "initialize": {
        if (isNotification) return;
        respondResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }

      case "notifications/initialized":
        // Pure notification, no response expected - just acknowledges the client is ready.
        return;

      case "ping": {
        if (isNotification) return;
        respondResult(id, {});
        return;
      }

      case "tools/list": {
        if (isNotification) return;
        respondResult(id, { tools: ALL_TOOL_DEFINITIONS });
        return;
      }

      case "tools/call": {
        if (isNotification) return;
        const toolName = params?.name as string | undefined;
        const args = (params?.arguments as Record<string, unknown>) ?? {};
        if (!toolName) {
          respondError(id, -32602, 'Missing "name" in tools/call params');
          return;
        }
        const result = await callTool(toolName, args);
        respondResult(id, result);
        return;
      }

      default:
        if (isNotification) {
          log(`ignoring unknown notification "${method}"`);
          return;
        }
        respondError(id, -32601, `Method not found: "${method}"`);
    }
  } catch (err) {
    log(`unhandled error in ${method}:`, err);
    if (!isNotification) {
      respondError(id, -32603, err instanceof Error ? err.message : String(err));
    }
  }
}

function main() {
  log(`starting, targeting Gateway at ${process.env.HEXFORGE_URL ?? "http://localhost:8080"}`);

  // MCP's stdio transport is newline-delimited JSON, not the
  // Content-Length-prefixed framing LSP uses - one complete JSON-RPC
  // message per line. Node delivers stdin in arbitrary chunk boundaries
  // that don't line up with message boundaries, so incomplete lines have
  // to be buffered across chunks rather than parsed as they arrive.
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // last element is either "" or an incomplete line - keep it for next time

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        log("failed to parse incoming line as JSON:", trimmed.slice(0, 200));
        continue;
      }
      void handleRequest(parsed);
    }
  });

  process.stdin.on("end", () => {
    log("stdin closed, exiting");
    process.exit(0);
  });

  process.on("uncaughtException", (err) => {
    // Must not crash silently or throw the default Node handler's output
    // at stdout/stderr in an uncontrolled way - log to stderr and keep running.
    log("uncaught exception:", err);
  });
}

main();
