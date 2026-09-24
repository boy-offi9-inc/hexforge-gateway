# Project structure

Where things live, and how a request moves through them.

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
        shared/exec-error.ts      common error shaping for spawned tools
        filesystem.search.worker.ts  worker thread for regex search (ReDoS timeout)
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
scripts/
  hf.sh                            CLI wrapper for manual testing
  smoke-test.sh                    automated end-to-end test
docs/
  SETUP.md / ARCHITECTURE.md / AGENTS.md / AI.md / MCP_SERVER.md / PLUGINS.md / CLI.md
  MT_MANAGER.md                    APK MCP setup with real screenshots
  PROJECT_STRUCTURE.md / ROADMAP.md
  images/                          screenshots used by MT_MANAGER.md
.github/workflows/
  ci.yml                           typecheck + build + real smoke-test.sh run + MCP handshake check, on every push/PR
  release.yml                      tags + publishes a GitHub Release when package.json's version is bumped
.github/ISSUE_TEMPLATE/
  bug-report.md                    bug / integration issue template
LICENSE                            MIT
README.md / CONTRIBUTING.md / SECURITY.md / CODE_OF_CONDUCT.md
Dockerfile                         container image for MCP introspection (Glama)
glama.json                         Glama directory listing config
supabase.schema.sql                tables for the optional Supabase backend
.env.example                       every config variable, documented
```

## How the pieces talk

Routes call into `modules/*` services directly (simple, synchronous
calls); those services publish to the Event Bus for anything
lifecycle-related, and things like the WebSocket gateway and the
Knowledge Indexer subscribe to those events rather than being called
directly. See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the engines and
the full event table.
