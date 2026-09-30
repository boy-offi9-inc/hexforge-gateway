# Roadmap

Everything core is built and documented in the other `docs/` files: Event
Bus, Job/Workflow Engines, Knowledge Engine, all eight MCP agents, Auth,
nine AI providers, Terminal chat, the MCP Server Frontend, the Plugin
System, local storage, and CI. This page tracks what's still open.

## Open

- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)
- [ ] Wider unit test coverage: the API routes' request validation is still untested (the MCP agents remain out of scope for unit tests - they shell out to real binaries/hardware) - see `tests/README.md`'s "not covered yet"

## Done

- [x] PC-side equivalent of MT Manager's APK MCP (`src/modules/inbox/inbox-watcher.ts`, `docs/INBOX.md`) - a poll-based watched folder (`APK_INBOX_DIR`, opt-in/off by default) that claims a dropped `.apk` into its own workspace once it's stopped changing size across two polls, moves it to `<WORKSPACES_ROOT>/<workspaceId>/inbox/`, and surfaces it via `GET /workspaces/:id/inbox` and the new `get_inbox_apks` MCP tool - both just list that directory on disk, no separate index to drift out of sync
- [x] Streamable HTTP transport for the MCP Server Frontend (`src/mcp-server/http.ts`) alongside the original stdio one (`index.ts`) - both now sit on top of a shared, transport-agnostic `protocol.ts` rather than duplicating JSON-RPC dispatch. `POST /mcp` returns a single JSON response (HexForge's tools never need SSE - see `docs/MCP_SERVER.md`), plus optional shared-key auth and Origin checking since this one is actually reachable over a network
- [x] AI provider layer unit tests (`ai-provider.test.ts`, mocked `fetch`): Anthropic, the shared OpenAI-compatible shape (Groq/OpenAI/DeepSeek/xAI/Mistral/openai-compatible), Gemini, and Ollama - each provider's not-configured error, exact request shape, response parsing, non-ok HTTP errors, malformed/empty responses, and (Groq/Ollama) a network-level `fetch` rejection
- [x] Job/Workflow Engine retry-and-failure-path unit tests, plus local-storage.provider's upsert/delete/list/concurrency correctness (`npm test`, Vitest) - CI runs this alongside `scripts/smoke-test.sh` now. See `tests/README.md` for what's covered and what still isn't
- [x] Scoped `/ws/workspaces/:id` alongside the original unscoped `/ws` firehose - filters by each event's `workspaceId` before forwarding, so a per-workspace client isn't handed every other workspace's traffic
- [x] Job/Workflow persistence (write-through to `jobs`/`workflows` tables with local-storage fallback, mirroring `knowledge.service.ts`). A job/workflow left `running`/`queued` across a restart is marked `failed` on hydrate rather than resumed, since the underlying McpTask was never persisted
- [x] Committed lockfile (`package-lock.json`) - CI uses `npm ci` for reproducible builds
- [x] Local storage caches each collection in memory after the first read, instead of re-reading and re-parsing the whole JSON file on every call. Splitting per-workspace is worth revisiting only if collections outgrow memory
- [x] Automatic GitHub Releases when the `package.json` version is bumped
