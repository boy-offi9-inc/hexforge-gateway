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
- `POST /workspaces/:id/tasks` — dispatch a task to an MCP agent (`{ agent, operation, payload? }`) - fire-and-forget, poll `GET /workspaces/:id/tasks` or watch `/ws` for the result
- `POST /workspaces/:id/jobs` — submit a retryable job (same body, plus optional `maxAttempts`) - see [Job Engine](#job-engine)
- `POST /workspaces/:id/workflows` — submit a multi-step workflow - see [Workflow Engine](#workflow-engine)
- `POST /workspaces/:id/knowledge` — create a knowledge entry - see [Knowledge Engine](#knowledge-engine)
- `POST /workspaces/:id/chat` / `GET /workspaces/:id/chat` — chat with the AI about a workspace - see [AI Provider Layer](#ai-provider-layer)
- `GET /plugins` — list plugins that loaded successfully this run
- `WS /ws` — real-time `task:update`, `job:update`, `workflow:update`, `knowledge:entry_created`, `workspace:status_changed`

Full request/response shapes for each are documented in the section
covering that feature, linked above.

## Device requirements

Minimums, not comfort levels - the Gateway itself is a lightweight Node
process, but jadx/apktool are JVM tools that can get memory- and
CPU-hungry on large or heavily obfuscated APKs.

**Software (either platform):**
- Node.js 20+
- `jadx` and `apktool` on `PATH` if you'll use those agents (both need a JVM - `openjdk-17` or similar)
- `adb` on `PATH` for the `adb` agent (Android platform-tools)
- `frida-tools` (`pip install frida-tools`, needs Python) plus a matching `frida-server` on the target device for the `frida` agent - the version match between the two is the most common Frida failure
- `apkid` (`pip install apkid`, needs a yara-python build with DEX support) for the `apkid` agent
- `curl` + `jq` for `scripts/hf.sh` and `scripts/smoke-test.sh`

**RAM:** No hard minimum for the Gateway process alone - it's small. The
real constraint is jadx/apktool decompiling a specific APK: small/simple
apps are fine on modest hardware, large or obfuscated ones need
noticeably more heap and time. Rarely a problem on a PC. On Android via
Termux, a device with less than ~4GB total RAM will likely struggle on
anything beyond small APKs - not a number that can be pinned down
precisely, since it depends entirely on the APK.

**Storage:** The Gateway's own data (`data/*.json`, workspace/knowledge
metadata) stays tiny. The real space usage is `WORKSPACES_ROOT`, where
jadx/apktool output lands - decompiled source can run several times the
original APK's size. Budget per APK you work with, not once for the
whole project.

**Android version (Termux):** Android 7.0+ works with Termux installed
via F-Droid or GitHub releases (the recommended install path - see
"Running on Android" below). The Google Play Store build of Termux is
discouraged and has reduced functionality; that build specifically needs
Android 11+. Check [Termux's own docs](https://github.com/termux/termux-app)
for anything more current, since app store requirements shift over time.

**Network:** None required at all with `STORAGE_BACKEND=local` (the
default) and `AI_PROVIDER=ollama` or `openai-compatible` pointed at a
local server - the Gateway can run fully offline. Network is only needed
for a cloud AI provider, `STORAGE_BACKEND=supabase`, or the
`webhook-notifier` plugin actually sending anything.

## Auth

Off by default. `core/auth.ts` is an opt-in API key check - without it,
every route trusts whoever can reach the port: `adb shell` runs arbitrary
commands on a connected device, `filesystem` can write and delete files,
`apktool`/`jadx` can rebuild and resign APKs. Reasonable for a local,
single-user tool; not once the Gateway is reachable beyond `localhost`.

Turn it on:

```bash
AUTH_ENABLED=true
API_KEYS=some-long-random-key,another-key-for-a-second-device
```

Then send the key as either header on every request:

```bash
curl -H "Authorization: Bearer some-long-random-key" http://localhost:8080/workspaces
# or
curl -H "X-API-Key: some-long-random-key" http://localhost:8080/workspaces
```

`GET /health` is always exempt (so uptime checks work without a key) -
everything else, including `GET /` (which lists workspace names), is
gated once auth is on. Multiple comma-separated keys in `API_KEYS` let
different devices/people use their own, so you can revoke one without
rotating everyone's.

One safety net: `AUTH_ENABLED=true` with an empty `API_KEYS` doesn't lock
you out - it's treated as still-open, with a warning printed at startup,
rather than silently making every route unreachable including to you.
`GET /health`'s `authEnabled` field only reports `true` once a real key
is configured, so you can confirm it's actually active rather than
assuming from the env var alone.

The CLI wrapper picks this up automatically - set `HEXFORGE_API_KEY` and
every `hf`/`smoke-test.sh` command sends it.

This is deliberately simple: one flat list of shared keys, no per-key
scopes, no expiry, no user accounts. Fine for a single operator's own
devices; if this project grows into something with actual multiple
untrusted users, `core/auth.ts` is the one file to replace, not extend.

## Storage: local (default) or Supabase

`STORAGE_BACKEND` picks where `workspaces` and `knowledge_entries` live:

- **`local`** (the default) — everything goes to
  `providers/local-storage.provider.ts`, a JSON file per collection under
  `DATA_DIR` (default `./data/`). Writes are atomic (temp file + rename)
  so a killed process (common on mobile/Termux) can't corrupt it. No
  Supabase project, no network calls, no setup. `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` are ignored entirely in this mode, even if
  they're set in `.env`.
- **`supabase`** — Supabase is primary, and a runtime failure (offline,
  DNS failure, outage) falls back to the same local file store
  automatically instead of crashing the request. Switch to this once
  there's an actual reason to share state across devices/users - e.g.
  once a web interface exists.

To use Supabase: create a project, run `supabase.schema.sql` in the SQL
editor, then set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`STORAGE_BACKEND=supabase` in `.env`. `GET /health`'s `storageBackend`
field confirms which mode is actually active.

Worth knowing either way:

- **No sync between the two.** Anything written to local storage while
  on `supabase` mode during an outage stays local-only - check
  `data/*.json` for anything written during the gap if that matters.
  Switching `local` → `supabase` later doesn't auto-migrate existing
  local data either.
- **Not a real database.** No indexing, no migrations, no query language
  - a flat `{ id: record }` JSON map per collection. Concurrent writes
  *within one process* are safe (`upsertRecord`/`deleteRecord` serialize
  per collection so two requests racing on the same collection can't
  silently drop one's write) but that doesn't extend across multiple
  processes sharing one `DATA_DIR`, which isn't a supported setup.
- **Jobs and Workflows are still in-memory only**, regardless of
  `STORAGE_BACKEND` - no local-storage or Supabase branch yet for those
  (see the note in `supabase.schema.sql`).

Falling back is logged (`[workspace.service] Supabase ... failed,
falling back to local storage: ...`), so it's visible rather than silent.

## AI Provider Layer

`src/providers/ai.provider.ts` exposes one function, `complete()`, backed
by nine interchangeable providers - **Anthropic**, **Groq**, **Gemini**,
**Ollama**, **OpenAI**, **DeepSeek**, **xAI (Grok)**, **Mistral**, and a
generic **openai-compatible** option for anything else that speaks the
same shape (LM Studio, llama.cpp's server, vLLM, text-generation-webui,
OpenRouter, ...). Six of these - Groq, OpenAI, DeepSeek, xAI, Mistral,
and openai-compatible - share one implementation internally
(`completeWithOpenAiCompatibleShape`) since they're all the OpenAI Chat
Completions request/response shape against a different base URL; only
Anthropic, Gemini, and Ollama needed their own code. Adding a new
provider that speaks this shape is a ~10-line addition - see
`CONTRIBUTING.md`.

```bash
AI_PROVIDER=anthropic   # or "groq", "gemini", "ollama", "openai", "deepseek", "xai", "mistral", "openai-compatible"

# Only the settings matching AI_PROVIDER are required - the rest can stay blank.
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5          # optional, this is the default

GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile       # optional, this is the default

GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-2.0-flash            # optional, this is the default

OLLAMA_BASE_URL=http://localhost:11434   # optional, this is the default
OLLAMA_MODEL=llama3.3                    # optional, this is the default
OLLAMA_API_KEY=                          # only needed for cloud models

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-5.4-mini                # optional, this is the default

DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-flash         # optional, this is the default - note deepseek-chat/deepseek-reasoner (older docs' examples) were deprecated 2026-07-24

XAI_API_KEY=xai-...
XAI_MODEL=grok-4-6                       # optional, this is the default

MISTRAL_API_KEY=...
MISTRAL_MODEL=mistral-large-latest       # optional, this is the default - a Mistral-maintained alias, not a version that goes stale

OPENAI_COMPATIBLE_BASE_URL=http://localhost:1234/v1   # optional, LM Studio's default
OPENAI_COMPATIBLE_API_KEY=               # most local servers don't need one
OPENAI_COMPATIBLE_MODEL=                 # required - no sensible default, depends what you're running
```

Groq and Gemini both have usable free tiers, unlike a fresh
Anthropic/OpenAI/DeepSeek/xAI/Mistral account which needs paid credits
first - handy for testing without billing setup. **Ollama** and
**openai-compatible** need zero API keys and zero external network
calls - everything runs on your own machine. Ollama is the simpler path
(install, `ollama serve`, `ollama pull llama3.3`) and also covers
Ollama's *cloud* models through the same endpoint - point `OLLAMA_MODEL`
at a `-cloud`-suffixed name (e.g. `gpt-oss:120b-cloud`) and set
`OLLAMA_API_KEY`, no separate provider needed. See
https://docs.ollama.com/cloud. `openai-compatible` is for anything else -
LM Studio, llama.cpp's server - point `OPENAI_COMPATIBLE_BASE_URL` at it
and set `OPENAI_COMPATIBLE_MODEL`.

`GET /health` reports `aiProvider` and `aiConfigured`. For Ollama,
`aiConfigured` just means "selected" - local mode has no key to check, so
the Gateway can't confirm the server is reachable without making a call.
Same for `openai-compatible`: it just means `OPENAI_COMPATIBLE_MODEL` is set.

Three things sit on top of the provider:

**The `ai` MCP agent** (`modules/mcp/agents/ai.agent.ts`) - a normal
agent (`agent: "ai"`), registered exactly like `jadx`/`apktool`. AI calls
made via a Job or Workflow step get retries and `job.*`/`workflow.*`
events for free. Operation: `"summarize"`, payload `{ content, instructions? }`.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/jobs \
  -H "Content-Type: application/json" \
  -d '{"agent": "ai", "operation": "summarize", "payload": {"content": "..."}}'
```

**`summarizeEntry()`** (`modules/ai/ai.service.ts`) - reads an existing
`KnowledgeEntry`, summarizes it, stores the result as a new `"summary"`
entry linked back via `relatedEntryIds`.

```bash
curl -X POST http://localhost:8080/knowledge/<entryId>/summarize
```

Returns `503` if the configured provider's key isn't set, `502` if the
provider's API call fails (e.g. Anthropic's "credit balance too low", or
an invalid key).

**`chat()`** (`modules/ai/ai.service.ts`) - real multi-turn conversation,
not a single-shot completion. `CompletionRequest` has a `history` field;
every provider builds its own multi-turn shape from it (Anthropic's
`messages` array, Gemini's `contents` with `role: "model"` instead of
`"assistant"` - the one real shape difference - and the OpenAI-style
`{role, content}` array everyone else uses). History loads from that
workspace's `"chat"`-type `KnowledgeEntries` on every call rather than
held in memory, so a conversation survives a Gateway restart.

History size is bounded three ways, not just a flat turn count - a flat
count alone doesn't actually control token cost, since a handful of long
messages (someone pasting a large `summarize_text` result, a decompiled
file) can blow past any reasonable count-based limit anyway:
- **Turn count**: at most the most recent 20 turns are ever considered.
- **Per-message length**: any single historical turn over ~4,000
  characters is truncated (with a clear marker noting how much was cut)
  before being resent - without this, one huge message gets sent in full
  on every subsequent chat call for as long as it stays in the window,
  repeating that cost turn after turn.
- **Total character budget**: history is walked newest-first and capped
  at a combined ~12,000 characters (a rough token budget), so a chat
  full of long messages naturally includes fewer old turns than one with
  short messages, rather than a fixed count regardless of size.

The budget walk moves in complete turn-pairs (a user message with its
paired assistant reply), never splitting one - several providers
(Anthropic in particular) reject a message array that starts or ends on
the "wrong" role, so trimming mid-pair isn't just messier, it can break
the request outright. The live message you're sending right now is never
truncated by any of this - only *past* turns being resent as context are
affected.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "What did the last jadx decompile find?"}'

curl http://localhost:8080/workspaces/<id>/chat   # full transcript, oldest-first
```

Or from the terminal with `hf chat` - see [CLI wrapper](#cli-wrapper-scriptshfsh) below.

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
  queues/                         reserved - not yet built (Jobs/Workflows are in-memory, see Storage section)
scripts/
  hf.sh                            CLI wrapper for manual testing
  smoke-test.sh                    automated end-to-end test
.github/workflows/
  ci.yml                           typecheck + build + real smoke-test.sh run + MCP handshake check, on every push/PR
LICENSE                            MIT
CONTRIBUTING.md
```

Routes call into `modules/*` services directly (simple, synchronous
calls); those services publish to the Event Bus for anything
lifecycle-related, and things like the WebSocket gateway and the
Knowledge Indexer subscribe to those events rather than being called
directly. See [Event Bus](#event-bus) below.

## Event Bus

`src/events/event-bus.ts` is a typed, in-process pub/sub singleton, per
`HexForge_Architecture_v2.md`'s "modules communicate through events
rather than direct calls" principle. Every event and its payload shape is
defined in `src/events/types.ts` (`EventMap`) - add a new event by adding
a line there, then `eventBus.emit(...)` / `eventBus.on(...)` anywhere
with full type safety.

| event | emitted by | payload |
|---|---|---|
| `workspace.created` | workspace service | `{ workspace }` |
| `workspace.status_changed` | workspace service | `{ workspace, previousStatus }` |
| `mcp.task.created` / `.updated` / `.completed` / `.failed` | MCP orchestrator | `{ task }` (`.updated` fires on every transition) |
| `job.created` / `.updated` / `.completed` / `.failed` | Job Engine | `{ job }` (`.updated` fires on every transition, including retries) |
| `workflow.created` / `.updated` / `.completed` / `.failed` | Workflow Engine | `{ workflow }` (`.updated` fires on every step advancing) |
| `knowledge.entry_created` / `.entry_updated` | Knowledge Engine | `{ entry }` |
| `plugin.loaded` / `.failed` | Plugin loader | `{ name }` / `{ name, error }` |

The WebSocket gateway (`src/core/websocket.ts`) subscribes to the events
it broadcasts - it has no direct reference to the orchestrator, Job
Engine, Workflow Engine, Knowledge Engine, or plugin loader. Same for the
Knowledge Indexer subscribing to `workflow.*`. This is the seam anything
new should plug into: subscribe to the events you care about, no direct
coupling to where they originate.

Implementation is deliberately a thin wrapper around Node's
`EventEmitter` (in-process, in-memory). If HexForge ever needs
cross-process delivery (multiple Gateway instances), a Redis-backed
pub/sub implementation can slot in behind the same `emit`/`on`/`off`
interface without touching any calling code.

## Job Engine

`src/modules/jobs/job-engine.ts` wraps a single MCP task dispatch with
retry logic - the "Jobs" layer from `HexForge_Architecture_v2.md`'s flow
(`Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents`). The Workflow
Engine calls `jobEngine.submit()` the same way you can directly, just
composing several Jobs together for a multi-step run.

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/jobs \
  -H "Content-Type: application/json" \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "/path/to/app.apk"}, "maxAttempts": 3}'
```

- `GET /workspaces/:id/jobs` — list jobs for a workspace
- `GET /jobs/:jobId` — fetch one job by id

A job creates a fresh underlying `McpTask` on each attempt. If that task
fails and `attempts < maxAttempts`, the Job Engine automatically
dispatches a new task and tries again; `job.attempts` and
`job.currentTaskId` track which attempt/task is live. Once attempts are
exhausted (or a task succeeds), the job reaches `completed`/`failed` and
publishes the matching event - `/ws` broadcasts every `job.updated` as
`{"type": "job:update", "job": {...}}`, so you can watch retries happen live.

**Testing retries**: point a job at something that will reliably fail
once (e.g. `jadx` with a deliberately wrong `apkPath`) with
`maxAttempts: 1` first to confirm it fails cleanly, then bump
`maxAttempts` and watch `attempts` climb over `/ws` or repeated
`GET /jobs/:jobId` polls before it finally reports `failed`.

## Workflow Engine

`src/modules/workflow/workflow-engine.ts` composes several Jobs into one
named operation - e.g. an "Analyze APK" workflow: decompile -> index
source -> AI summary. Steps run strictly sequentially; the Workflow
Engine calls `jobEngine.submit()` for one step at a time and only
dispatches the next once the current step's Job reaches a terminal
state. Retries *within* a step are already handled by the Job Engine via
that step's own `maxAttempts` - the Workflow Engine just reacts to
`completed`/`failed`, it doesn't re-implement retry logic.

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Analyze APK",
    "steps": [
      { "agent": "jadx", "operation": "decompile", "payload": { "apkPath": "/absolute/path/to/app.apk" }, "maxAttempts": 2 },
      { "agent": "filesystem", "operation": "list", "mergePreviousResult": true }
    ]
  }'
```

- `GET /workspaces/:id/workflows` — list workflows for a workspace
- `GET /workflows/:workflowId` — fetch one, including per-step status/result/error

`mergePreviousResult: true` on a step shallow-merges the *previous*
step's result object into that step's payload before dispatch (result
keys win on conflict) - e.g. so a step after `jadx:decompile` can pick up
`outputDir` without the caller having to know it ahead of time. Omit it
if a step's payload is fully self-contained.

If any step's Job exhausts its `maxAttempts` and fails, the whole
workflow stops immediately and moves to `failed` with an error naming
which step failed - later steps are never dispatched. `/ws` broadcasts
every `workflow.updated` as `{"type": "workflow:update", ...}`, same as
jobs and tasks.

## Knowledge Engine

`src/modules/knowledge/` stores chats, reports, notes, and summaries as a
single `KnowledgeEntry` shape (`type` distinguishes them). Two parts:

- **`knowledge.service.ts`** — plain CRUD (local storage or Supabase, per
  `STORAGE_BACKEND`).
- **`knowledge-indexer.ts`** — a background listener (not a route)
  subscribing to `workflow.completed`/`workflow.failed` and
  auto-creating a `"report"` entry summarizing every finished workflow
  run. The Workflow Engine never calls into the Knowledge Engine
  directly - pure Event Bus decoupling. Registered once at startup via
  `registerKnowledgeIndexer()` in `core/server.ts`.

`relatedEntryIds` links a generated `"summary"` back to what it
summarized (see `summarizeEntry()` above). `embedding` is still unused -
nothing in this project generates embeddings yet. `"chat"`-type entries
are written by `ai.service.ts`'s `chat()` - one entry per turn, `source:
"user"` vs `source: "system"` distinguishing who said it.

Endpoints:

- `POST /workspaces/:id/knowledge` — create an entry (`{ type, title, content, relatedEntryIds? }`)
- `GET /workspaces/:id/knowledge?type=report` — list, optional `type` filter
- `GET /knowledge/:entryId` — fetch one
- `PATCH /knowledge/:entryId` / `DELETE /knowledge/:entryId` — update / delete
- `POST /knowledge/:entryId/summarize` — see AI Provider Layer above
- `POST /workspaces/:id/chat` / `GET /workspaces/:id/chat` — see AI Provider Layer above

## MCP agents

`src/modules/mcp/orchestrator.ts` registers a handler per agent kind.
`jadx`, `apktool`, `apkid`, `apkmcp`, `filesystem`, `adb`, and `frida` all
have real implementations - `frida` has the biggest asterisk on "real"
(see below). Dispatching a task (`POST /workspaces/:id/tasks`) is
fire-and-forget: it returns immediately with `status: "queued"`, then
moves to `running` then `completed`/`failed` as the handler runs - poll
`GET /workspaces/:id/tasks` or watch `/ws` for the result, same as Jobs.

### filesystem

For browsing/searching jadx/apktool output without leaving the API, or
general file management scoped to a workspace. Trust model:
`list`/`read`/`stat`/`search` accept any absolute path on the machine
(same as `jadx`/`apktool` already trust an arbitrary `apkPath`) - `write`
and `delete` are sandboxed to the workspace's own directory under
`WORKSPACES_ROOT/<workspaceId>/`, since those are destructive.

```bash
# search decompiled output for permission strings
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "filesystem", "operation": "search", "payload": {"dirPath": "<jadx output dir>", "pattern": "android\\.permission\\.[A-Z_]+"}}'
```

Operations: `list` (`dirPath`, `recursive?`, `limit?`), `read` (`filePath`,
`encoding?: "utf8"|"base64"`), `write` (`filePath`, `content`, `encoding?`
- sandboxed), `delete` (`filePath` - sandboxed), `stat` (`filePath`),
`search` (`dirPath`, `pattern` - a regex, `caseSensitive?`, `extensions?`,
`maxResults?`), `scan-secrets` (`dirPath`, `extensions?`, `maxResults?`) -
same walk-and-match machinery as `search`, but against a curated built-in
set of high-precision patterns (AWS/Google API keys, private key headers,
Slack/GitHub tokens, JWTs) instead of a user-supplied one. Deliberately
not exhaustive - favors patterns distinctive enough to keep false
positives low over generic ones like `password=...` that would flood
results with test fixtures. Not a replacement for a maintained
secret-scanner (gitleaks, trufflehog) on anything that actually matters.

`search`'s pattern is user-supplied (and `scan-secrets`' built-in
patterns are still regexes) and regex engines can be tricked into
catastrophic backtracking (e.g. `(a+)+` against a non-matching input can
hang effectively forever). Since a single synchronous `RegExp.test()`
call can't be interrupted once started, both run in a worker thread
(`filesystem.search.worker.ts`) with a 10s timeout - hitting it kills the
worker and returns a clear timeout error instead of a hung request.

### adb

Requires `adb` on `PATH`. Talks to whatever device/emulator you already
have adb access to - `deviceSerial` is optional on every operation, only
needed with more than one device connected.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "adb", "operation": "install", "payload": {"apkPath": "<rebuilt apk>", "reinstall": true}}'
```

Operations: `devices`, `packages` (`filter?`), `install` (`apkPath`,
`reinstall?`), `uninstall` (`packageName`, `keepData?`), `shell`
(`command`), `logcat` (`filter?`, `lines?` - dumps and tails the current
buffer rather than streaming live, matching this Gateway's
request/response model), `pull` (`remotePath`, `fileName?` - saved under
`WORKSPACES_ROOT/<workspaceId>/adb/pulled/`), `push` (`localPath`, `remotePath`).

`shell` runs whatever command you give it on the device - as powerful as
`adb shell` itself. Fine for a local, single-user tool; don't expose the
Gateway beyond localhost without turning on Auth first.

### frida

Frida is fundamentally interactive/streaming - attach, inject, watch
hook events live for as long as you want. This Gateway is
request/response, so `trace` compromises the same way `adb logcat` does:
spawn or attach, inject a script, capture whatever it emits within a
bounded window, then kill it. For a real interactive session, use the
`frida` CLI directly - this agent is for "run this hook for N seconds and
tell me what happened."

Requires `frida-tools` on `PATH` and a `frida-server` running on the
target device, **matching your frida-tools version** - the single most
common Frida failure is a version mismatch between the two.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "frida", "operation": "trace",
    "payload": {
      "target": "com.example.app",
      "script": "Java.perform(function () { console.log(\"attached\"); });",
      "timeoutSeconds": 15
    }
  }'
```

Operations:
- `list-devices` — `frida-ls-devices`
- `list-processes` (`deviceSerial?`, `includeApps?`) — `frida-ps`, optionally with installed (not just running) apps
- `push-server` (`localServerPath`, `deviceSerial?`, `remotePath?`) — adb-pushes a `frida-server` binary and chmods it executable
- `start-server` / `stop-server` (`deviceSerial?`, `remotePath?`) — best-effort, **requires root**; backgrounding over a single `adb shell` call is fragile by nature, verify with `list-processes` rather than trusting the response alone
- `trace` (`target`, `mode?: "spawn"|"attach"`, `script`, `timeoutSeconds?` - default 15, capped at 60) — `target` is a package name in `spawn` mode, or a PID/process name in `attach` mode; `script` is raw Frida JS, written to `WORKSPACES_ROOT/<id>/frida/scripts/` before running

Timing out isn't a failure - it's the expected way `trace` ends, since a
script has no way to signal "I'm done" back to this agent. The
response's `timedOut` field tells you which happened; `stdout`/`stderr`
contain whatever the script emitted before the window closed either way.
Non-root devices need Frida's Gadget-based injection instead of a
`frida-server` push, which this agent doesn't implement.

### jadx

Requires `jadx` on `PATH`. Produces readable Java-like source for browsing.

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'
```

Output goes to `WORKSPACES_ROOT/<workspaceId>/jadx/`; the result contains
the output directory and a capped file listing.

### apktool

Requires `apktool` on `PATH`. Unlike `jadx`, decodes resources to
editable XML and disassembles code to **smali** - and can rebuild an APK
from a decoded project, which `jadx` cannot do. Use it to modify and
repackage an app, not just read it.

```bash
# decode
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "decode", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'

# rebuild after editing the decoded project
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "build", "payload": {"inputDir": "<decode output dir, edited>", "outputName": "rebuilt.apk"}}'
```

Decode output: `WORKSPACES_ROOT/<workspaceId>/apktool/decode/`. Optional
decode flags: `noSrc: true` (resources only, faster), `noRes: true`
(smali only). Build output:
`WORKSPACES_ROOT/<workspaceId>/apktool/build/<outputName>`.

**Important:** the rebuilt APK is unsigned and won't install until
signed - this project doesn't wire up signing for the apktool path. Use
`apkmcp`'s build flow (signs automatically) for a signed result, or sign
manually with `apksigner`. Only rebuild and install apps you own or are
authorized to modify.

### apkid

Requires `apkid` on `PATH` (`pip install apkid` - needs a yara-python
build with DEX support first, see
[APKiD's install docs](https://github.com/rednaga/APKiD#installation),
plain `pip install yara-python` isn't enough). Wraps
[APKiD](https://github.com/rednaga/APKiD), a real, actively-maintained
YARA-rules-based fingerprinter for compilers, packers, obfuscators, and
anti-debug/anti-VM tricks - deliberately not reimplemented as a weaker
heuristic here, since APKiD's rules are maintained by people who actually
track new packers.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkid", "operation": "identify", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'
```

Operation: `identify` (`apkPath`, `timeoutSeconds?` - per-file YARA scan
timeout, default 30). Output is APKiD's own JSON passed through as-is,
not reshaped into a HexForge-specific structure - that schema belongs to
APKiD, not duplicated and drifted out of sync here.

### apkmcp

A generic Model Context Protocol client with convenience operations
built for MT Manager's built-in "APK MCP" service (Android only - see
"Running on Android" below for setup). Default target
`http://127.0.0.1:8787/mcp`; override with `baseUrl` in the payload.

| operation | payload fields | maps to |
|---|---|---|
| `list_tools` | — | `tools/list` |
| `list_available_apks` | `prefix?`, `limit?` | `mt_apk_list_available_apks` |
| `open` | `path`, `temporary?` | `mt_apk_open` |
| `list` | `workspaceId`, `view?`, `prefix?`, `limit?` | `mt_apk_list` |
| `outline_class` | `workspaceId`, `locator` | `mt_apk_outline_class` |
| `read_text` | `workspaceId`, `locator` | `mt_apk_read_text` |
| `search` | `workspaceId`, `query`, `target?` | `mt_apk_search` |
| `close` | `workspaceId` | `mt_apk_close` |
| `call_tool` | `tool`, `arguments` | escape hatch for anything else |

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "open", "payload": {"path": "apks/app.apk", "temporary": false}}'

# grab the returned data.workspaceId, then:
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "list", "payload": {"workspaceId": "<mtWorkspaceId>", "view": "dex_classes"}}'
```

Note: MT's `path` must be **relative** to its configured "MCP operation
directory" - absolute paths are rejected. Use `list_available_apks` if
unsure of the relative path.

`mt_apk_edit_*` and `mt_apk_build` (which can modify and re-sign an APK)
aren't wrapped in a convenience operation - use `call_tool` directly, and
only point them at apps you own or are authorized to modify.

## MCP Server Frontend

Everything above this point is HexForge speaking MCP as a *client* (to
MT Manager's APK MCP service). `src/mcp-server/` is HexForge speaking MCP
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

## Plugin System

`src/plugins/` - per `HexForge_Architecture_v2.md`'s Plugin System
("Allows official and community extensions without changing the core").
A plugin is a folder under `plugins/installed/<name>/index.ts` that
default-exports a `HexForgePlugin`:

```ts
import type { HexForgePlugin } from "../../types.js";

const plugin: HexForgePlugin = {
  name: "my-plugin",
  version: "0.1.0",
  register(ctx) {
    ctx.registerAgent("my-agent", async (task) => ({ ok: true }));
    ctx.on("job.completed", (payload) => ctx.log.info(`job ${payload.job.id} done`));
    ctx.app.get("/plugins/my-plugin/ping", async () => "pong");
  },
};

export default plugin;
```

`ctx` (`PluginContext`, in `plugins/types.ts`) is the entire surface a
plugin gets - it never imports the orchestrator, Event Bus, or Fastify
app directly:

- `ctx.registerAgent(kind, handler)` — adds a new MCP agent kind, usable in Tasks/Jobs/Workflows exactly like the built-ins
- `ctx.on(event, listener)` — subscribes to any Event Bus event
- `ctx.app` — the live Fastify instance, for plugin-owned routes
- `ctx.log` — prefixed console logger (`[plugin:<name>] ...`)

Because a plugin's agent kind isn't known ahead of time, the `agent`
field on Task/Job/Workflow-step request schemas is an open string, not a
fixed enum - a misspelled or unloaded agent still fails cleanly with
`"No handler registered for agent ..."` on that specific Task.

`plugins/loader.ts` discovers every folder under `plugins/installed/` at
startup (after all core routes/indexers are registered) and calls each
plugin's `register()`. One plugin throwing is logged and skipped - it
can't take down the Gateway or another plugin. Restrict which load with
`PLUGINS_ENABLED=name-one,name-two` in `.env` (unset = load everything
found). `GET /plugins` lists what actually loaded; `plugin.loaded` /
`plugin.failed` fire on the Event Bus either way.

Two working reference plugins ship in `plugins/installed/`:

- **`example-strings/`** — adds a `strings` MCP agent (runs the
  `strings` utility on any file), subscribes to `job.completed` to log
  its own runs, and adds a `GET /plugins/example-strings/info` route.
  Demonstrates the "new agent" pattern.

  ```bash
  curl -X POST http://localhost:8080/workspaces/<id>/jobs \
    -H "Content-Type: application/json" \
    -d '{"agent": "strings", "operation": "extract", "payload": {"filePath": "/absolute/path/to/some/file"}}'
  ```

- **`webhook-notifier/`** — demonstrates the event-only pattern: no new
  agent or route. Set `WEBHOOK_NOTIFIER_URL` and it POSTs a small JSON
  body whenever a Job or Workflow completes or fails, so you don't have
  to poll a long-running decompile to know when it's done. Unset, it
  still loads successfully but stays idle. No retries if your endpoint
  is down.

Copy either folder as a starting point for a real plugin.

## CLI wrapper (scripts/hf.sh)

For manual testing (curl from a terminal/Termux), copying generated ids
out of every response into the next command gets old fast. `hf.sh` wraps
the API and remembers the current workspace/job/workflow id in
`~/.hexforge/state.env`, so most commands need zero ids typed:

```bash
chmod +x scripts/hf.sh   # once
alias hf=./scripts/hf.sh # optional, from the repo root

hf ws clite-analysis                 # get-or-create workspace "clite-analysis", becomes current
hf ws-list                           # see every workspace that exists on the server
hf job jadx decompile '{"apkPath": "/storage/emulated/0/MT2/apks/Clite Dialer_1.0.apk"}'
hf job-status                        # no id needed - uses the job just submitted
hf wf analyze '[{"agent":"jadx","operation":"decompile","payload":{"apkPath":"/path/app.apk"}}]'
hf wf-status                         # no id needed - uses the workflow just submitted
hf knowledge                         # list knowledge entries for the current workspace
hf chat                              # interactive terminal chat - see below
hf current                           # show what's currently selected
```

Set `HEXFORGE_URL` if the Gateway isn't on `localhost:8080`, and
`HEXFORGE_API_KEY` if `AUTH_ENABLED=true`. Requires `curl` and `jq`. Run
`hf` with no args to get oriented - prints the full command list plus
your current workspace and every workspace on the server, so a
first-time contributor never has to guess an id or read this README
before doing anything.

### Terminal chat

```bash
hf ws clite-analysis
hf chat
```

Drops into a REPL - type a message, get a reply, repeat; `exit`, `quit`,
or Ctrl+D to leave. Every message and reply is a real request to `POST
/workspaces/:id/chat` (nothing client-side is faked), so the same
conversation is visible via `hf chat-log` or `GET /workspaces/:id/chat`
later, from a different terminal, or eventually a web UI.

Implementation note if you're extending `hf.sh`: chat input is genuinely
free-form text (quotes, backslashes, newlines - anything), unlike every
other command's inputs here which are controlled (ids, package names,
JSON typed carefully). `chat` builds its request body with
`jq -n --arg`, which JSON-encodes the string properly regardless of
content - naive string interpolation would break the moment someone
typed a quote mark. Reuse `jq -n --arg` for any new free-text command.

### Automated smoke test (scripts/smoke-test.sh)

```bash
./scripts/smoke-test.sh
```

End-to-end pass over everything that doesn't need external Android
tooling: workspace get-or-create, the `filesystem` agent
(write/read/search/delete, plus confirming a write *outside* the
workspace dir is correctly refused), a Job, a Workflow (including
`mergePreviousResult` and confirming the Knowledge Indexer auto-created
a report entry), Knowledge Engine CRUD, AI (a summarize job plus a full
chat round-trip - skipped with a clear reason if unconfigured), and the
Plugin System (`GET /plugins`, plus actually running the
`example-strings` agent if `strings` is on `PATH`). Prints
`[PASS]`/`[FAIL]`/`[SKIP]` per check and a summary; exits non-zero on
any failure.

Leaves the workspace it creates in place afterward
(`smoke-test-<timestamp>`) rather than cleaning up, so you can inspect
real data with `hf ws-id <id>` / `hf knowledge` instead of it vanishing
when the script exits. Prints exact `hf` commands at the end for what it
can't test itself: `jadx`/`apktool` (need a real `.apk`), `adb` (needs a
device/emulator), `frida` (needs frida-tools + frida-server), `apkmcp`
(needs MT Manager running on Android).

Same env vars as `hf.sh`.

## Running on PC (Windows/Mac/Linux)

Nothing about the Gateway itself is Android/Termux-specific except the
MT Manager integration.

```bash
cp .env.example .env
npm install
npm run dev
```

Install `jadx`/`apktool` the normal way for your OS (`brew install jadx`
on macOS, download-and-extract on Windows/Linux from
[jadx releases](https://github.com/skylot/jadx/releases) and
[apktool.org/docs/install](https://apktool.org/docs/install)) - both just
need to be on `PATH`. Point the `jadx`/`apktool` agents at any local file
path directly - `apkPath`/`inputDir` accept an absolute path on your
machine, no MT Manager required:

```bash
curl -X POST http://localhost:8080/workspaces/<id>/jobs \
  -H "Content-Type: application/json" \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "C:/Users/you/Downloads/app.apk"}}'
```

**`apkmcp` doesn't apply here** - it's built for MT Manager, an
Android-only app. There's no PC equivalent yet (a watched folder you
could drop APKs into instead of typing full paths - see Roadmap below);
for now, just use full paths.

## Running on Android (Termux + MT Manager)

Runs entirely on-device - Gateway and MT Manager as two apps on the same
phone, talking over loopback.

**1. Termux basics**

```bash
pkg update && pkg upgrade
pkg install nodejs git openjdk-17
termux-setup-storage   # grants access to /storage/emulated/0/... for apkPath payloads
```

**2. jadx and apktool** - neither ships in Termux's main repo, so install
manually: download from
[jadx releases](https://github.com/skylot/jadx/releases) and
[apktool's install page](https://apktool.org/docs/install), extract, and
put the executables on `PATH` (e.g. symlink into `$PREFIX/bin`). Confirm
both work standalone (`jadx --version`, `apktool --version`) before
pointing the Gateway at them.

**3. MT Manager's APK MCP** - in MT Manager, find the APK MCP feature
(under Settings/Tools - exact wording varies by version):
- Set the **MCP operation directory** to wherever your APKs live (e.g. `/storage/emulated/0/MT2/apks`) - MT only accepts paths relative to this directory.
- Start the service - defaults to `http://127.0.0.1:8787/mcp`, matching this project's default. Since Termux and MT Manager run on the same device, loopback is directly reachable with no extra network setup.

Verify:
```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "list_available_apks", "payload": {}}'
```
If that fails, check MT's APK MCP service is actually running first -
it doesn't always survive MT Manager being backgrounded.

**4. Keeping the Gateway running** - Android kills backgrounded Termux
sessions to save battery. Run `termux-wake-lock` before long sessions. A
killed process is exactly the scenario `local-storage.provider.ts`'s
atomic writes are meant to survive cleanly - see
[Storage](#storage-local-default-or-supabase) above, and it's why local
storage is the default backend in the first place.

## Roadmap

Everything else in this README - Event Bus, Job/Workflow Engines,
Knowledge Engine, all eight MCP agents, Auth, nine AI providers, Terminal
chat, the MCP Server Frontend, the Plugin System, local storage, CI - is
built and documented in its own section above. What's genuinely still open:

- [ ] Scope `/ws` connections per-workspace (currently broadcasts everything to every connection)
- [ ] Job/Workflow Supabase persistence (currently in-memory only regardless of `STORAGE_BACKEND` - see the note in `supabase.schema.sql`)
- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)
- [ ] PC-side equivalent of MT Manager's APK MCP - a watched/drop folder for APKs instead of typing full paths every time
- [ ] Streamable HTTP transport for the MCP Server Frontend (currently stdio only - fine for Claude Desktop/Code spawning it locally, not for a remote/networked MCP client)
- [ ] Committed lockfile (`package-lock.json`) - CI uses `npm install` rather than `npm ci` because none exists yet, so builds aren't fully reproducible
- [ ] Real unit/integration tests. CI now runs `scripts/smoke-test.sh` against a live instance on every push/PR, which is real coverage for the happy paths it exercises - but it's still one script asserting end-to-end outcomes, not a test suite covering edge cases, error paths, or anything that needs mocking (e.g. a provider API returning malformed JSON)
- [ ] Local storage's per-collection design means `listEntriesForWorkspace` reads and parses the *entire* `knowledge_entries.json` (every type, every workspace) on every call, even when filtering to one workspace's chat history - fine at current scale, worth indexing or splitting per-workspace before it isn't
