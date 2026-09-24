# Roadmap

Everything core is built and documented in the other `docs/` files: Event
Bus, Job/Workflow Engines, Knowledge Engine, all eight MCP agents, Auth,
nine AI providers, Terminal chat, the MCP Server Frontend, the Plugin
System, local storage, and CI. This page tracks what's still open.

## Open

- [ ] Scope `/ws` connections per-workspace (currently broadcasts everything to every connection)
- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)
- [ ] PC-side equivalent of MT Manager's APK MCP - a watched/drop folder for APKs instead of typing full paths every time
- [ ] Streamable HTTP transport for the MCP Server Frontend (currently stdio only - fine for Claude Desktop/Code spawning it locally, not for a remote/networked MCP client)
- [ ] Real unit/integration tests. CI runs `scripts/smoke-test.sh` against a live instance on every push/PR, which is real coverage for the happy paths it exercises - but it's one script asserting end-to-end outcomes, not a suite covering edge cases, error paths, or anything that needs mocking (e.g. a provider API returning malformed JSON)

## Done

- [x] Job/Workflow persistence (write-through to `jobs`/`workflows` tables with local-storage fallback, mirroring `knowledge.service.ts`). A job/workflow left `running`/`queued` across a restart is marked `failed` on hydrate rather than resumed, since the underlying McpTask was never persisted
- [x] Committed lockfile (`package-lock.json`) - CI uses `npm ci` for reproducible builds
- [x] Local storage caches each collection in memory after the first read, instead of re-reading and re-parsing the whole JSON file on every call. Splitting per-workspace is worth revisiting only if collections outgrow memory
- [x] Automatic GitHub Releases when the `package.json` version is bumped
