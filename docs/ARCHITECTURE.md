# Architecture: Event Bus, Job Engine, Workflow Engine, Knowledge Engine

The four engines that sit between the API routes and the MCP agents -
how HexForge composes retries, multi-step workflows, and persistent
knowledge on top of a single task dispatch, following a
`Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents` flow.

## Event Bus

`src/events/event-bus.ts` is a typed, in-process pub/sub singleton -
modules communicate through events rather than direct calls. Every event
and its payload shape is
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

It exposes two routes over the same subscription logic: `GET /ws` is an
unscoped firehose (every workspace's events, to every connection - the
original behavior); `GET /ws/workspaces/:id` filters to one workspace by
reading each event's `workspaceId` (or, for `workspace.status_changed`,
the workspace's own `id`) before forwarding. Prefer the scoped route for
anything workspace-specific (a per-workspace UI panel, a script watching
one analysis run) so it isn't handed every other workspace's traffic to
filter out itself.

Implementation is deliberately a thin wrapper around Node's
`EventEmitter` (in-process, in-memory). If HexForge ever needs
cross-process delivery (multiple Gateway instances), a Redis-backed
pub/sub implementation can slot in behind the same `emit`/`on`/`off`
interface without touching any calling code.


## Job Engine

`src/modules/jobs/job-engine.ts` wraps a single MCP task dispatch with
retry logic - the "Jobs" layer in the
`Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents` flow. The Workflow
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

## Artifacts

`src/artifacts/` records what finished tasks produced, so decompiled sources,
a decoded APK project or a rebuilt APK can be listed and found again instead
of being re-derived from a task's raw result. Three parts:

- **`artifact.service.ts`** — CRUD over local storage (`artifacts`
  collection; there is no Supabase table for it yet, so
  `STORAGE_BACKEND=supabase` does not change this). Producing the same kind at
  the same path again (jadx re-decompiling into its output directory) updates
  the existing record instead of adding a duplicate: id and `createdAt` stay,
  `source` points at the latest run. Emits `artifact.created` /
  `artifact.updated`.
- **`recorder.ts`** — a background listener on `mcp.task.completed`, the same
  decoupled pattern as the knowledge indexer, registered once via
  `registerArtifactRecorder()` in `core/server.ts`. It reads the agent's
  capability descriptor ([AGENTS](AGENTS.md#capabilities)): an operation that
  declares exactly one output kind and whose result carries `outputDir` (a
  directory) or `outputPath` (a file) produces one artifact. Today that is
  `jadx.decompile`, `apktool.decode`, `apktool.build`, `filesystem.scan-secrets`
  and `frida.trace`; plugin agents join by declaring `outputs` in their
  descriptor. Anything else records nothing
  rather than guessing. A failure is logged and never affects the task.
- **`GET /workspaces/:id/artifacts?kind=apk`** — list, newest first, optional
  `kind` filter. **`GET /artifacts/:artifactId`** — fetch one.

`scan-secrets` and `trace` save their full result with `withSavedOutput()`
(`modules/mcp/agents/task-output.ts`), one JSON file per task id under the
workspace, and return its path as `outputPath`. Because each run writes its own
file, an artifact for one of these never changes after it is recorded, which
keeps a [finding](#findings) that cites it stable. (`jadx` and `apktool`
re-use their output directory, so re-running them updates that artifact in
place.) If the file can't be written the operation still succeeds, just
without an `outputPath` and so without an artifact.

An artifact carries `kind`, `path`, `pathType` (`file` or `directory`), a
`source` (task id, agent, operation, capability) and `tools`: the adapter's
backend tools with the versions installed when it was produced.
`capabilities/tool-versions.ts` reads those by running each tool's version
command (`jadx --version`, `apktool --version`, `apkid --version`,
`adb version`, `frida --version`) with a 5 second timeout. A version found
is remembered for the process; a probe that fails (tool missing, timeout) is
retried next time and simply leaves that tool without a version - it never
fails the recording. Backends with no local probe, like `frida-server` on the
device, are listed without one. Every task triggered through
a Job or Workflow is covered too, since they dispatch through the same
orchestrator.

## Findings

`src/findings/` stores claims about the target together with the evidence
behind them: a `Finding` has a `claim`, a `status` (`unverified`, `confirmed`
or `contradicted`), an optional `confidence` (`low`/`medium`/`high`) and
`reasoning`, a `source` (`user`, `ai` or `system`, so it is clear who made the
claim) and `evidence[]`. Each piece of evidence is an `artifactId` plus an
optional `location` (e.g. `com/acme/Api.java:12`), `note` and `entityId`; the
tool, version, run and time come from the artifact's own record
([Artifacts](#artifacts)) rather than being copied. `entityId` says which thing
in the [knowledge graph](#knowledge-graph) the evidence is about, e.g. the
class `com.acme.Api` cited together with the decompile it was found in.

The rules are enforced when a finding is saved, in `finding.service.ts`:

- every cited artifact must exist **and** belong to the same workspace, so a
  finding can't cite something that isn't there or came from another target;
- a finding can't be `confirmed` without at least one piece of evidence -
  creating it that way, or patching it to `confirmed`, is rejected;
- a cited `entityId` must be an entity of the same workspace **and** must have
  been observed in the artifact it is cited with (that artifact is in the
  entity's `artifactIds`), so "this class, in this decompile" is something
  that was really recorded;
- an update re-checks the rules against the result, so replacing evidence with
  an unknown artifact fails and leaves the finding as it was.

Violations raise `EvidenceError`, which the routes return as a `400`. Findings
are stored in local storage only for now (no Supabase table yet) and emit
`finding.created` / `finding.updated`.

Endpoints:

- `POST /workspaces/:id/findings` — create (`{ claim, status?, confidence?, reasoning?, evidence?, source? }`)
- `GET /workspaces/:id/findings?status=confirmed&entityId=...` — list, newest first, optional `status` filter and `entityId` (findings whose evidence cites that graph entity)
- `GET /findings/:findingId` — fetch one
- `PATCH /findings/:findingId` — update `status`, `confidence`, `reasoning` or `evidence`

## Knowledge graph

`src/graph/` holds typed things observed about the target and the
relationships between them, next to the free-text [Knowledge Engine](#knowledge-engine).
It is a schema and an API, plus one indexer for decompiled Java
([below](#populating-it)).

An **entity** has a `type` (`package`, `class`, `method`, `native-function`,
`resource`, `url`, `secret-candidate`, `runtime-event`, `traffic-event`), a
`name`, primitive `attributes` and `artifactIds` - the [artifacts](#artifacts)
it was observed in. Names identify an entity within a workspace (fully
qualified for code, e.g. `com.acme.Login`) and must never be a secret value.
Its id is derived from workspace + type + name, so reporting the same thing
again merges into the existing entity instead of duplicating it: attributes
are overlaid (new values win) and artifact ids are unioned.

An **edge** is directed, with a `relation` (`contains`, `calls`, `invokes`,
`maps-to`, `accesses`, `observed-by`, `supports`). Its id is derived from
workspace + from + relation + to, so adding an existing edge changes nothing.

Rules enforced in `graph.service.ts`:

- cited artifacts must exist in the same workspace;
- both ends of an edge must be entities of that workspace, and can't be the
  same entity;
- violations raise `GraphError`, which the routes return as a `400`.

Because ids are derived, creating and merging are single lookups; the list
endpoints still scan the whole collection (the storage layer has no queries),
which is fine for hundreds or low thousands of records but is the thing to
revisit before indexing a full app. Local storage only for now, like
artifacts and findings. Emits `graph.entity_upserted` and `graph.edge_created`.

Endpoints:

- `POST /workspaces/:id/graph/entities` — upsert (`{ type, name, attributes?, artifactIds? }`); `201` if new, `200` if merged
- `GET /workspaces/:id/graph/entities?type=class&q=login` — list by name, optional `type` and name-substring `q`
- `GET /graph/entities/:entityId` — the entity and every edge touching it
- `POST /workspaces/:id/graph/edges` — add (`{ from, to, relation }`); `201` if new, `200` if it already existed
- `GET /workspaces/:id/graph/edges?entityId=...&relation=calls` — list; `entityId` matches either end

### Populating it

`graph/java-indexer.ts` listens for recorded artifacts (`artifact.created` and
`artifact.updated`, registered once in `core/server.ts` like the artifact
recorder) and, for a `java-sources` directory - what `jadx.decompile`
produces - reads the decompiled files and creates:

- a `class` entity per `.java` file, named from its path
  (`com/acme/Login.java` is `com.acme.Login`), with the source `file` as an
  attribute so a finding can cite it as a location;
- a `package` entity per directory that holds classes, with a `classCount`;
- a `contains` edge from each package to its classes.

It reads jadx's `sources/` folder (a sibling `resources/` is ignored), or the
artifact directory itself when there is no `sources/`. Files that aren't
`.java`, and `package-info` / `module-info`, are skipped; a class at the top
level has no package. Re-indexing the same decompile merges rather than
duplicates, and `apktool` projects are not indexed.

It goes through `graphService.indexBatch`, which does the whole job with one
write per collection and one `graph.indexed` event, because every write
rewrites the whole collection file. Even so, a decompile with more than
20,000 classes is cut to the first 20,000 (in path order) and a warning says
so. Indexing failures are logged and never affect the decompile.
