# Roadmap

Everything core is built and documented in the other `docs/` files: Event
Bus, Job/Workflow Engines, Knowledge Engine, all eight MCP agents, Auth,
nine AI providers, Terminal chat, the MCP Server Frontend, the Plugin
System, local storage, and CI. This page tracks what's still open.

## Open

- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)
- [ ] PC-side equivalent of MT Manager's APK MCP - a watched/drop folder for APKs instead of typing full paths every time
- [ ] Streamable HTTP transport for the MCP Server Frontend (currently stdio only - fine for Claude Desktop/Code spawning it locally, not for a remote/networked MCP client)
- [ ] Wider unit test coverage: the AI provider layer's per-provider request/response handling (mock `fetch`, assert request shape and malformed-response handling) and the API routes' request validation are still untested - see `tests/README.md`'s "not covered yet"

## Done

- [x] Job/Workflow Engine retry-and-failure-path unit tests, plus local-storage.provider's upsert/delete/list/concurrency correctness (`npm test`, Vitest) - CI runs this alongside `scripts/smoke-test.sh` now. See `tests/README.md` for what's covered and what still isn't
- [x] Scoped `/ws/workspaces/:id` alongside the original unscoped `/ws` firehose - filters by each event's `workspaceId` before forwarding, so a per-workspace client isn't handed every other workspace's traffic
- [x] Job/Workflow persistence (write-through to `jobs`/`workflows` tables with local-storage fallback, mirroring `knowledge.service.ts`). A job/workflow left `running`/`queued` across a restart is marked `failed` on hydrate rather than resumed, since the underlying McpTask was never persisted
- [x] Committed lockfile (`package-lock.json`) - CI uses `npm ci` for reproducible builds
- [x] Local storage caches each collection in memory after the first read, instead of re-reading and re-parsing the whole JSON file on every call. Splitting per-workspace is worth revisiting only if collections outgrow memory
- [x] Automatic GitHub Releases when the `package.json` version is bumped
