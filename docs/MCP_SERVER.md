# MCP Server Frontend

`docs/AGENTS.md`'s `apkmcp` agent is HexForge speaking MCP as a *client*
(to MT Manager's APK MCP service). `src/mcp-server/` is HexForge speaking MCP
as a *server* - a stdio-based MCP server any MCP client (Claude Desktop,
Claude Code, Cursor, etc.) can register directly, so its agents show up
as native tools instead of only being reachable through the REST API or
this repo's own CLI.

This matters because most comparable projects in this space *are*
MCP servers first - a client registers them and calls their tools
directly. HexForge wasn't originally built that way: it's an HTTP Gateway
with its own persistent Jobs/Workflows/Knowledge Engine, which none of
those single-purpose MCP servers have. `src/mcp-server/` doesn't replace
that - it's a thin adapter in front of it. Every tool call becomes a real
HTTP request to an already-running Gateway (`src/mcp-server/gateway-client.ts`)
and reuses all of its actual logic - retries via the Job Engine, workspace
resolution, everything. This process doesn't start a Gateway itself; one
needs to already be running.

**Setup:**

```bash
npm run build   # compiles src/mcp-server/ to dist/mcp-server/ same as everything else
```

Then point your MCP client's config at it. For Claude Desktop
(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hexforge": {
      "command": "node",
      "args": ["/absolute/path/to/hexforge-gateway/dist/mcp-server/index.js"],
      "env": {
        "HEXFORGE_URL": "http://localhost:8080"
      }
    }
  }
}
```

Add `HEXFORGE_API_KEY` to `env` too if the Gateway has `AUTH_ENABLED=true`.
The Gateway (`npm run dev` or `npm start`) needs to already be running
separately - this config only starts the thin MCP adapter, not the
Gateway itself.

**Tools exposed** (`src/mcp-server/tools.ts`) - a curated ~19, not a 1:1
mirror of every agent operation, picked for what's useful to drive
directly: `list_workspaces`, `get_or_create_workspace`,
`list_knowledge`, `chat_with_workspace`, `decompile_apk`, `decode_apk`,
`build_apk`, `identify_packer`, `scan_secrets`, `search_code`,
`read_file`, `list_files`, `adb_devices`, `adb_shell`, `adb_install`,
`adb_logcat`, `frida_list_processes`, `frida_trace`, `summarize_text`.
Every workspace-scoped tool takes an optional `workspace` name argument
(not an id) defaulting to `"default"`, resolved through the Gateway's
get-or-create-by-name endpoint - the calling AI never needs to know or
track a workspace id.

**Implementation notes**, since a broken stdio MCP server tends to fail
silently and confusingly rather than with a clear error:

- **Only `writeMessage()` ever touches stdout.** MCP's stdio transport is
  newline-delimited JSON-RPC - any stray `console.log`, a dependency that
  logs to stdout, anything at all besides a framed protocol message,
  corrupts the stream for the client reading it. Every log line in this
  server goes to stderr via `log()`. Verified with a grep pass that
  `console.log` doesn't appear anywhere in `src/mcp-server/`.
- **Chunk-boundary buffering.** Node delivers stdin in arbitrary chunks
  that don't line up with message boundaries - a single JSON-RPC message
  can arrive split across two `data` events. The buffering logic
  (accumulate, split on `\n`, keep the last incomplete line for next
  time) was stress-tested against messages deliberately split mid-JSON
  across chunk boundaries before trusting it.
- **Tool errors vs protocol errors.** A tool that fails (bad path, jadx
  not installed) returns a normal MCP result with `isError: true` inside
  it - not a JSON-RPC-level error. That distinction is deliberate: a
  JSON-RPC error means the *call itself* was malformed (a client bug);
  `isError: true` means the tool ran and didn't work, which the model
  needs to see to react to (try a different path, ask the user to
  install something) rather than have swallowed as an opaque protocol failure.
- **Every tool call blocks until its job settles** (or a 2-minute poll
  timeout), rather than returning `"queued"` and making the caller check
  back - MCP tool calls are expected to behave like a normal function
  call that returns a real result, so the waiting happens inside
  `gateway-client.ts`'s `runJob()`, not pushed onto whoever's driving the client.
- **Tool results are compact JSON, not pretty-printed.** This text goes
  straight into an AI model's context on every tool call, not a terminal
  a human reads - the indentation/newlines a pretty-print adds are pure
  token overhead here (measured ~33% fewer characters compact vs pretty
  on a representative result). Worth remembering before "helpfully"
  adding `null, 2` back for readability.

