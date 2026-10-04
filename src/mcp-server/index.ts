#!/usr/bin/env node
/**
 * HexForge's MCP server frontend, stdio transport. Speaks the Model
 * Context Protocol over stdio - the transport Claude Desktop, Claude
 * Code, and most other MCP clients spawn a server with - so any of them
 * can register HexForge's agents as native tools, without needing to
 * know the Gateway has its own REST API underneath.
 *
 * All actual protocol/tool logic lives in protocol.ts, shared with the
 * Streamable HTTP transport (http.ts) - this file is only stdio framing:
 * reading newline-delimited JSON-RPC off stdin, writing it back to
 * stdout. See docs/MCP_SERVER.md for which transport to pick.
 *
 * ABSOLUTE RULE: nothing but framed JSON-RPC messages may ever reach
 * stdout. A stray console.log, an uncaught promise rejection printed by
 * Node, a dependency that logs to stdout - any of it corrupts the
 * message stream for the client reading it. All logging in this file
 * goes to stderr via `log()`, on purpose, everywhere.
 *
 * Usage (after `npm run build`):
 *   node dist/mcp-server/index.js
 * Point your MCP client's config at that command. Set HEXFORGE_URL /
 * HEXFORGE_API_KEY in the environment the client launches it with if the
 * Gateway isn't on the default localhost:8080 or has auth enabled.
 */

import { handleRequest, log, type JsonRpcRequest } from "./protocol.js";

function writeMessage(message: Record<string, unknown>) {
  // The one and only thing allowed to touch stdout in this whole process.
  process.stdout.write(JSON.stringify(message) + "\n");
}

function main() {
  log(
    `starting (stdio transport), targeting Gateway at ${process.env.HEXFORGE_URL ?? "http://localhost:8080"}`,
  );

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
        log(
          "failed to parse incoming line as JSON:",
          err instanceof Error ? err.message : String(err),
          "-",
          trimmed.slice(0, 200),
        );
        continue;
      }
      void handleRequest(parsed).then((response) => {
        if (response) writeMessage(response);
      });
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
