# Architecture: Event Bus, Job Engine, Workflow Engine, Knowledge Engine

The four engines that sit between the API routes and the MCP agents -
how HexForge composes retries, multi-step workflows, and persistent
knowledge on top of a single task dispatch, per
`HexForge_Architecture_v2.md`'s `Workspace -> Workflow -> Jobs -> Tasks
-> MCP Agents` flow.

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
summarized (see `summarizeEntry()` in `docs/AI.md`). `embedding` is still
unused - nothing in this project generates embeddings yet. `"chat"`-type
entries are written by `ai.service.ts`'s `chat()` - one entry per turn,
`source: "user"` vs `source: "system"` distinguishing who said it.

Endpoints:

- `POST /workspaces/:id/knowledge` — create an entry (`{ type, title, content, relatedEntryIds? }`)
- `GET /workspaces/:id/knowledge?type=report` — list, optional `type` filter
- `GET /knowledge/:entryId` — fetch one
- `PATCH /knowledge/:entryId` / `DELETE /knowledge/:entryId` — update / delete
- `POST /knowledge/:entryId/summarize` — see AI Provider Layer above
- `POST /workspaces/:id/chat` / `GET /workspaces/:id/chat` — see AI Provider Layer above

