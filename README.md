# HexForge Gateway

AI-assisted APK reverse-engineering workspace API. Manages workspaces,
dispatches tasks to MCP agents (jadx, apktool, adb, frida, filesystem,
MT Manager's APK MCP, AI providers), and streams updates over WebSocket.
Runs entirely on-device (Termux + MT Manager on Android) or on a normal
PC - no cloud dependency required.

See `HexForge_Architecture_v2.md` for the original design doc this
project follows (`Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents`,
modules communicating through an Event Bus) and `HexForge_Documentation.md`
for earlier context.

MIT licensed (`LICENSE`). Contributing: see `CONTRIBUTING.md` - the short
version is `npm run typecheck && npm run build && ./scripts/smoke-test.sh`
before opening a PR; `.github/workflows/ci.yml` runs the same checks
automatically, plus a handshake check on the MCP server frontend.

## Documentation

This README covers getting started and orientation. Everything else
lives in `docs/` - one file per concern, so you're not reading a
novel-length README to find the one thing you need:

| Doc | Covers |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Device requirements, Auth, Storage backend (local vs Supabase), running on PC, running on Android/Termux |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Event Bus, Job Engine, Workflow Engine, Knowledge Engine - how the engines fit together |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Every MCP agent - filesystem, adb, frida, jadx, apktool, apkid, apkmcp - operations and examples |
| [`docs/AI.md`](docs/AI.md) | The AI Provider Layer (9 providers), the `ai` agent, `summarizeEntry()`, and Terminal chat's memory/token-budget design |
| [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) | The MCP Server Frontend - registering HexForge's agents as native tools in Claude Desktop/Code/Cursor |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | The Plugin System - contract, loader, and both reference plugins |
| [`docs/CLI.md`](docs/CLI.md) | `scripts/hf.sh` (manual testing + Terminal chat) and `scripts/smoke-test.sh` (automated end-to-end test) |
| [`MT_MANAGER_MCP_SETUP.md`](MT_MANAGER_MCP_SETUP.md) | MT Manager's APK MCP setup, with real screenshots |

## Stack

- **Runtime**: Node.js 20+, TypeScript
- **Server**: Fastify (+ `@fastify/websocket`)
- **Validation**: Zod
- **Persistence**: local file storage by default (`STORAGE_BACKEND=local`);
  Supabase optional, opt-in via `STORAGE_BACKEND=supabase`
- **Auth**: opt-in API key check, off by default (`AUTH_ENABLED=false`)

## Getting started

```bash
npm install
cp .env.example .env
npm run dev
```

Server starts on `http://localhost:8080` by default. On start it prints a
banner with any existing workspaces and copy-pasteable commands to create
one. `GET /` returns the same information as JSON (live workspace list +
example commands) - the first thing worth hitting if you're new to this
repo and want to see what's here without reading further.

Core endpoints:

- `GET /` — live cheat sheet: existing workspaces + example commands
- `GET /health` — service + config status (storage backend, AI provider, auth)
- `POST /workspaces` — create a workspace (`{ name, targetLabel }`)
- `GET /workspaces` / `GET /workspaces/:id` — list / fetch
- `PUT /workspaces/by-name/:name` — get-or-create by name (`{ targetLabel? }`) — idempotent, so you never have to copy a workspace id out of a response again
- `POST /workspaces/:id/tasks` — dispatch a task to an MCP agent (`{ agent, operation, payload? }`) - fire-and-forget, poll `GET /workspaces/:id/tasks` or watch `/ws` for the result - see `docs/AGENTS.md`
- `POST /workspaces/:id/jobs` — submit a retryable job (same body, plus optional `maxAttempts`) - see `docs/ARCHITECTURE.md`
- `POST /workspaces/:id/workflows` — submit a multi-step workflow - see `docs/ARCHITECTURE.md`
- `POST /workspaces/:id/knowledge` — create a knowledge entry - see `docs/ARCHITECTURE.md`
- `POST /workspaces/:id/chat` / `GET /workspaces/:id/chat` — chat with the AI about a workspace - see `docs/AI.md`
- `GET /plugins` — list plugins that loaded successfully this run - see `docs/PLUGINS.md`
- `WS /ws` — real-time `task:update`, `job:update`, `workflow:update`, `knowledge:entry_created`, `workspace:status_changed`

Full request/response shapes for each are documented in the linked doc.

## Project layout

```
src/
  index.ts                        entrypoint - startup banner, then app.listen()
  core/
    config.ts                     env validation (zod)
    auth.ts                       opt-in API key check (off by default)
    server.ts                     fastify app assembly, route registration
    websocket.ts                  real-time update broadcasting
    types.ts                      shared TypeScript types
  api/v1/
    health.routes.ts / root.routes.ts
    workspace.routes.ts / job.routes.ts / workflow.routes.ts
    knowledge.routes.ts           (also owns the /chat routes)
    plugin.routes.ts
  modules/
    workspace/
      workspace.service.ts        workspace CRUD (local storage or Supabase)
    mcp/
      orchestrator.ts             task dispatch + agent handler registry
      agents/                     jadx, apktool, apkid, apkmcp, ai, filesystem, adb, frida
    jobs/
      job-engine.ts                retryable wrapper around a single MCP task dispatch
    workflow/
      workflow-engine.ts           sequential composition of several Jobs
    knowledge/
      knowledge.service.ts         KnowledgeEntry CRUD
      knowledge-indexer.ts         auto-creates a report entry when a workflow finishes
    ai/
      ai.service.ts                summarizeEntry() and chat() - ties the AI provider to the Knowledge Engine
  providers/
    supabase.client.ts            provider-layer abstraction over Supabase
    ai.provider.ts                provider-layer abstraction over the AI vendor
    local-storage.provider.ts     JSON-file storage, primary in local mode / fallback in supabase mode
  mcp-server/
    index.ts                       stdio MCP server frontend - JSON-RPC loop, tool dispatch
    tools.ts                       the ~19 MCP tools exposed, table-driven
    gateway-client.ts              thin HTTP client to an already-running Gateway
  plugins/
    types.ts                       PluginContext / HexForgePlugin contract
    loader.ts                      discovers + safely loads plugins/installed/*
    installed/
      example-strings/             reference plugin - new MCP agent pattern
      webhook-notifier/            reference plugin - event-only pattern
  events/
    event-bus.ts                  typed pub/sub singleton
    types.ts                      EventMap - every event + payload shape
  queues/                         reserved - not yet built (Jobs/Workflows are in-memory, see docs/SETUP.md)
scripts/
  hf.sh                            CLI wrapper for manual testing
  smoke-test.sh                    automated end-to-end test
docs/
  SETUP.md / ARCHITECTURE.md / AGENTS.md / AI.md / MCP_SERVER.md / PLUGINS.md / CLI.md
  images/                          screenshots used by MT_MANAGER_MCP_SETUP.md
.github/workflows/
  ci.yml                           typecheck + build + real smoke-test.sh run + MCP handshake check, on every push/PR
LICENSE                            MIT
CONTRIBUTING.md
MT_MANAGER_MCP_SETUP.md            APK MCP setup with real screenshots (see docs/SETUP.md for the rest of Android setup)
```

Routes call into `modules/*` services directly (simple, synchronous
calls); those services publish to the Event Bus for anything
lifecycle-related, and things like the WebSocket gateway and the
Knowledge Indexer subscribe to those events rather than being called
directly. See `docs/ARCHITECTURE.md`.

## Roadmap

Everything else - Event Bus, Job/Workflow Engines, Knowledge Engine, all
eight MCP agents, Auth, nine AI providers, Terminal chat, the MCP Server
Frontend, the Plugin System, local storage, CI - is built and documented
in `docs/` (see the table above). What's genuinely still open:

- [ ] Scope `/ws` connections per-workspace (currently broadcasts everything to every connection)
- [ ] Job/Workflow Supabase persistence (currently in-memory only regardless of `STORAGE_BACKEND` - see the note in `supabase.schema.sql`)
- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)
- [ ] PC-side equivalent of MT Manager's APK MCP - a watched/drop folder for APKs instead of typing full paths every time
- [ ] Streamable HTTP transport for the MCP Server Frontend (currently stdio only - fine for Claude Desktop/Code spawning it locally, not for a remote/networked MCP client)
- [ ] Committed lockfile (`package-lock.json`) - CI uses `npm install` rather than `npm ci` because none exists yet, so builds aren't fully reproducible
- [ ] Real unit/integration tests. CI now runs `scripts/smoke-test.sh` against a live instance on every push/PR, which is real coverage for the happy paths it exercises - but it's still one script asserting end-to-end outcomes, not a test suite covering edge cases, error paths, or anything that needs mocking (e.g. a provider API returning malformed JSON)
- [ ] Local storage's per-collection design means `listEntriesForWorkspace` reads and parses the *entire* `knowledge_entries.json` (every type, every workspace) on every call, even when filtering to one workspace's chat history - fine at current scale, worth indexing or splitting per-workspace before it isn't
