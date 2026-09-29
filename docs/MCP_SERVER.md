# MCP Server Frontend

`docs/AGENTS.md`'s `apkmcp` agent is HexForge speaking MCP as a *client*
(to MT Manager's APK MCP service). `src/mcp-server/` is HexForge speaking MCP
as a *server* - any MCP client (Claude Desktop, Claude Code, Cursor, a
remote client over the network, etc.) can register it directly, so its
agents show up as native tools instead of only being reachable through the
REST API or this repo's own CLI. Two transports, same protocol/tool logic:

| | `src/mcp-server/index.ts` | `src/mcp-server/http.ts` |
|---|---|---|
| Transport | stdio (newline-delimited JSON-RPC) | Streamable HTTP (`POST /mcp`) |
| Use for | Claude Desktop, Claude Code, Cursor - anything that spawns its own server subprocess | a remote/networked MCP client, or anything that talks HTTP rather than spawning a subprocess |
| Run | `npm run mcp-server` (or `mcp-server:dev`) | `npm run mcp-server-http` (or `mcp-server-http:dev`) |

This matters because most comparable projects in this space *are*
MCP servers first - a client registers them and calls their tools
directly. HexForge wasn't originally built that way: it's an HTTP Gateway
with its own persistent Jobs/Workflows/Knowledge Engine, which none of
those single-purpose MCP servers have. `src/mcp-server/` doesn't replace
that - it's a thin adapter in front of it, in either transport. Every tool
call becomes a real HTTP request to an already-running Gateway
(`src/mcp-server/gateway-client.ts`) and reuses all of its actual logic -
retries via the Job Engine, workspace resolution, everything. Neither
transport starts a Gateway itself; one needs to already be running -
that's true whether the Gateway is on the same machine or, for the HTTP
transport, reachable over the network.

All actual protocol/tool dispatch logic - JSON-RPC method handling,
`tools/list`, `tools/call`, workspace resolution - lives in
`src/mcp-server/protocol.ts`, shared by both transports. `index.ts` and
`http.ts` are only the framing around it: reading/writing newline-
delimited JSON on stdio, or an HTTP request/response cycle. Adding a
third transport later means writing framing, not another copy of the
tool dispatch switch statement.

## stdio transport (`index.ts`)

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

## Streamable HTTP transport (`http.ts`)

For a client that can't spawn a local subprocess - a remote MCP client, a
client running in a different container, anything that talks HTTP. Start
it as its own long-running process:

```bash
npm run build
HEXFORGE_URL=http://localhost:8080 npm run mcp-server-http
```

Point a Streamable-HTTP-capable MCP client at `http://<host>:<port>/mcp`
(default `http://127.0.0.1:8788/mcp`). Env vars:

| Var | Default | Purpose |
|---|---|---|
| `MCP_HTTP_HOST` | `127.0.0.1` | bind address - see security note below before changing this |
| `MCP_HTTP_PORT` | `8788` | separate from the Gateway's own `PORT` (default 8080) since this is a different process |
| `MCP_HTTP_API_KEYS` | unset (no auth) | comma-separated shared keys; checked via `Authorization: Bearer <key>` or `X-API-Key: <key>` on every route except `/health` - same header scheme as the Gateway's own `core/auth.ts`, so one mental model covers both |
| `MCP_HTTP_ALLOWED_ORIGINS` | unset | comma-separated origins allowed to send a browser `Origin` header; see below |
| `HEXFORGE_URL` / `HEXFORGE_API_KEY` | same as stdio | the Gateway this transport forwards tool calls to |

**What's deliberately not implemented**, and why it's not a gap:
HexForge's tools always resolve to exactly one response and this server
never pushes an unsolicited server-to-client message, so per the MCP
Streamable HTTP spec's own allowance, every `POST /mcp` gets a single
JSON response rather than opening an SSE stream - there's never a second
message that would need one. `GET /mcp` (opening a standalone SSE session
for server-initiated messages) and `DELETE /mcp` (session termination)
both return an honest `405` rather than pretending to support something
that would never emit or terminate anything - this server also never
issues a session id, since every tool call is already a fresh,
independent Gateway request with no per-connection state to key one on.

**Security** - "reachable over the network" is a real change from
stdio's "reachable by whoever can spawn this process":

- Binds to `127.0.0.1` by default. Exposing this beyond localhost hands
  out the same capabilities the Gateway itself has (adb shell, filesystem
  writes, rebuilding APKs) - set `MCP_HTTP_API_KEYS` before changing
  `MCP_HTTP_HOST`.
- Every request's `Origin` header is checked. A non-browser client (curl,
  another server, most native MCP clients) simply doesn't send one, so
  requests with no `Origin` are allowed through by default; a request
  that does carry one must match `MCP_HTTP_ALLOWED_ORIGINS` or gets a
  `403`. This guards against a browser tab on an unrelated site sending a
  `fetch()` straight to `http://localhost:<port>/mcp` - the browser
  attaches that page's `Origin` automatically, and localhost being
  same-machine means DNS rebinding isn't even required for the attack.
- `MCP_HTTP_API_KEYS` unset (the default) means no auth, matching the
  Gateway's own opt-in-only default for local trusted use - the same
  tradeoff, made the same way, for the same reason.

## Tools exposed

(`src/mcp-server/tools.ts`, shared by both transports) - a curated ~19,
not a 1:1 mirror of every agent operation, picked for what's useful to
drive directly: `list_workspaces`, `get_or_create_workspace`,
`list_knowledge`, `chat_with_workspace`, `decompile_apk`, `decode_apk`,
`build_apk`, `identify_packer`, `scan_secrets`, `search_code`,
`read_file`, `list_files`, `adb_devices`, `adb_shell`, `adb_install`,
`adb_logcat`, `frida_list_processes`, `frida_trace`, `summarize_text`.
Every workspace-scoped tool takes an optional `workspace` name argument
(not an id) defaulting to `"default"`, resolved through the Gateway's
get-or-create-by-name endpoint - the calling AI never needs to know or
track a workspace id.

## Implementation notes

Since a broken MCP server tends to fail silently and confusingly rather
than with a clear error:

- **Only `writeMessage()` (stdio) ever touches stdout.** MCP's stdio
  transport is newline-delimited JSON-RPC - any stray `console.log`, a
  dependency that logs to stdout, anything at all besides a framed
  protocol message, corrupts the stream for the client reading it. Every
  log line in both transports goes to stderr via `log()`. Verified with a
  grep pass that `console.log` doesn't appear anywhere in
  `src/mcp-server/`. The HTTP transport has no equivalent constraint
  (stdout is just the process's normal stdout, nothing reads protocol
  messages off it), but keeps logging to stderr anyway for consistency
  and so both transports' logs interleave sensibly if run under the same
  process supervisor.
- **Chunk-boundary buffering (stdio only).** Node delivers stdin in
  arbitrary chunks that don't line up with message boundaries - a single
  JSON-RPC message can arrive split across two `data` events. The
  buffering logic (accumulate, split on `\n`, keep the last incomplete
  line for next time) was stress-tested against messages deliberately
  split mid-JSON across chunk boundaries before trusting it. The HTTP
  transport doesn't need this - one request body is one message, and
  `http.ts`'s `readBody()` already buffers the full body (capped at 10 MB)
  before ever handing it to `JSON.parse`.
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
