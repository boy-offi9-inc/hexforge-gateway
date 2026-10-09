# Roadmap

Everything core is built and documented in the other `docs/` files: Event
Bus, Job/Workflow Engines, Knowledge Engine, all eight MCP agents, Auth,
nine AI providers, Terminal chat, the MCP Server Frontend, the Plugin
System, local storage, and CI. This page tracks what's still open.

## Open

- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)

## Done

- [x] Typed knowledge graph (`src/graph/`): entities (package, class, method, native function, resource, URL, ...) and directed edges, merged by derived ids so re-reporting never duplicates, with cited artifacts and edge ends validated. Decompiled Java is indexed automatically into packages, classes and `contains` edges (capped at 20,000 classes per decompile). See `docs/ARCHITECTURE.md`
- [x] Evidence-backed findings (`src/findings/`): a claim with `status`, `confidence` and `evidence[]` citing artifacts. Evidence is validated on save (the artifact must exist in the same workspace) and a finding can't be `confirmed` without any. See `docs/ARCHITECTURE.md`
- [x] Artifact recorder (`src/artifacts/`): finished tasks whose operation declares an output (`jadx.decompile`, `apktool.decode`, `apktool.build`, `filesystem.scan-secrets`, `frida.trace`, plus plugin agents) are recorded as artifacts with the run that produced them and the versions of the backend tools behind it, listed by `GET /workspaces/:id/artifacts`. See `docs/ARCHITECTURE.md`
- [x] Capability registry (`src/capabilities/`): agents can describe what they do (capability ids, operations, payload keys, backends, permissions) through an optional descriptor on `registerAgent`; all eight built-in agents do, and `GET /capabilities` lists them. See `docs/AGENTS.md` and `docs/PLUGINS.md`
- [x] Gateway console output (`src/core/console-ui.ts`): on a terminal, a startup box with every address/storage/AI/auth/plugins/inbox plus targeted warnings (auth requested but no keys, open port reachable from the network, unconfigured AI), and one readable line per request with polling bursts collapsed, instead of four duplicate "listening" lines and raw JSON per request. Piped/systemd/Docker output is unchanged JSON (`LOG_FORMAT=json` forces it). See `docs/SETUP.md`
- [x] `hf` CLI rewrite (`scripts/hf/`): branded, colored, card-style output on a terminal with live job/workflow progress and a line-edited markdown-rendering chat REPL, while piped output stays byte-compatible with the old bash script (`--json`/`--plain`/exit codes for scripting). Node instead of curl+jq; `hf.sh` is now a launcher. See `docs/CLI.md`
- [x] API route request-validation tests (`api-routes.test.ts`) and auth hook tests (`auth.test.ts`) - every zod schema's rejection path, 404s, 503/502 from the AI-backed endpoints, and API key handling, via `app.inject()` on a bare Fastify instance. The MCP agents remain out of scope for unit tests (they shell out to real binaries/hardware); see `tests/README.md`
- [x] PC-side equivalent of MT Manager's APK MCP (`src/modules/inbox/inbox-watcher.ts`, `docs/INBOX.md`) - a poll-based watched folder (`APK_INBOX_DIR`, opt-in/off by default) that claims a dropped `.apk` into its own workspace once it's stopped changing size across two polls, moves it to `<WORKSPACES_ROOT>/<workspaceId>/inbox/`, and surfaces it via `GET /workspaces/:id/inbox` and the new `get_inbox_apks` MCP tool - both just list that directory on disk, no separate index to drift out of sync
- [x] Streamable HTTP transport for the MCP Server Frontend (`src/mcp-server/http.ts`) alongside the original stdio one (`index.ts`) - both now sit on top of a shared, transport-agnostic `protocol.ts` rather than duplicating JSON-RPC dispatch. `POST /mcp` returns a single JSON response (HexForge's tools never need SSE - see `docs/MCP_SERVER.md`), plus optional shared-key auth and Origin checking since this one is actually reachable over a network
- [x] AI provider layer unit tests (`ai-provider.test.ts`, mocked `fetch`): Anthropic, the shared OpenAI-compatible shape (Groq/OpenAI/DeepSeek/xAI/Mistral/openai-compatible), Gemini, and Ollama - each provider's not-configured error, exact request shape, response parsing, non-ok HTTP errors, malformed/empty responses, and (Groq/Ollama) a network-level `fetch` rejection
- [x] Job/Workflow Engine retry-and-failure-path unit tests, plus local-storage.provider's upsert/delete/list/concurrency correctness (`npm test`, Vitest) - CI runs this alongside `scripts/smoke-test.sh` now. See `tests/README.md` for what's covered and what still isn't
- [x] Scoped `/ws/workspaces/:id` alongside the original unscoped `/ws` firehose - filters by each event's `workspaceId` before forwarding, so a per-workspace client isn't handed every other workspace's traffic
- [x] Job/Workflow persistence (write-through to `jobs`/`workflows` tables with local-storage fallback, mirroring `knowledge.service.ts`). A job/workflow left `running`/`queued` across a restart is marked `failed` on hydrate rather than resumed, since the underlying McpTask was never persisted
- [x] Committed lockfile (`package-lock.json`) - CI uses `npm ci` for reproducible builds
- [x] Local storage caches each collection in memory after the first read, instead of re-reading and re-parsing the whole JSON file on every call. Splitting per-workspace is worth revisiting only if collections outgrow memory
- [x] Automatic GitHub Releases when the `package.json` version is bumped
