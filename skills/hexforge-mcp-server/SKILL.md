---
name: hexforge-mcp-server
description: Register HexForge's agents as native MCP tools in Claude Desktop, Claude Code or Cursor, or query a remote Gateway over the HTTP transport. Use when connecting an MCP client to HexForge.
---

# HexForge MCP server setup

HexForge speaks MCP as a server: any MCP client can register its agents as
native tools. Two transports, same tools - `src/mcp-server/index.ts` over
stdio, `src/mcp-server/http.ts` over Streamable HTTP. Every tool call is a
real request to an already-running Gateway, so start the Gateway first
(`npm run dev`, or the pinned Docker runtime).

## stdio (Claude Desktop, Claude Code, Cursor)

Build once (`npm run build`), then point the client at it.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hexforge": {
      "command": "node",
      "args": ["/absolute/path/to/hexforge-gateway/dist/mcp-server/index.js"],
      "env": {
        "HEXFORGE_URL": "http://localhost:8080",
        "HEXFORGE_API_KEY": "<only if the Gateway requires auth>"
      }
    }
  }
}
```

Claude Code (`.mcp.json` in the project, or `claude mcp add`):

```bash
claude mcp add hexforge -- node /absolute/path/to/hexforge-gateway/dist/mcp-server/index.js
```

## HTTP (remote Gateway)

For a Gateway reachable over the network, run the HTTP transport on the
Gateway host (`npm run mcp-server-http`) and point the client's HTTP-based
MCP config at `http://<host>:<port>/mcp`.

## Tools you get

`list_capabilities`, `list_artifacts`, `list_graph_entities`,
`get_graph_entity`, `list_findings`, `create_finding`, `update_finding`,
`verify_finding`, `get_report` - evidence-side tools that read (and for
findings, write) the Gateway's real state. Dispatch an analysis task via
the REST API or the `hexforge-apk-triage` skill, then read results back
through these tools.

## Troubleshooting

- Tools appear but every call fails: the Gateway isn't running at
  `HEXFORGE_URL`, or `HEXFORGE_API_KEY` is missing/wrong.
- Empty tool list: run `npm run build`; the stdio transport spawns
  `dist/mcp-server/index.js`, not the TypeScript sources.
