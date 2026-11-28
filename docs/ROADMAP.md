# Roadmap

Everything core is built and documented in the other `docs/` files: Event
Bus, Job/Workflow Engines, Knowledge Engine, all twelve MCP agents, Auth,
nine AI providers, Terminal chat, the MCP Server Frontend, the Plugin
System, local storage, and CI. This page tracks what's still open.

## Open

- [ ] Web interface (once this exists, `STORAGE_BACKEND=supabase` becomes worth turning back on for shared state)

## Done

- [x] Gadget injection (apktool `inject-gadget`): frida-gadget embedded into a decoded project (lib/<abi> + loadLibrary call in the application class's onCreate, .locals bumped), optional script-loading gadget config, recorded in patch lineage - non-root devices get full Frida via the normal build/sign/install chain. See `docs/AGENTS.md`
- [x] Headless native analysis (`ghidra` agent): Ghidra 12.2 (pinned in `Dockerfile.runtime`, JDK 25) runs `analyzeHeadless` on an ELF/.so (or any Ghidra-importable binary) in a temporary project - a plain-Java post-script decompiles every function (8 KiB/function cap, 2,000-function cap with truncation flagged) and records xrefs and call targets into one JSON report artifact, with a 50-function preview in the result. See `docs/AGENTS.md`
- [x] JNI correlation (`graph/native-indexer.ts`): the ghidra agent's native-analysis reports become `native-function` entities (name, address, size, 20k cap), and every exported symbol following the JNI naming rule (`Java_com_acme_Foo_bar`, escapes decoded, overload suffix dropped) gets a `maps-to` edge to the `native` Java method it implements - overloads all match the same symbol. The Java method keeps only its decompile artifacts as evidence; the edge links the two without faking observations. See `docs/ARCHITECTURE.md`
- [x] Graph URLs and strings (`graph/url-string-indexer.ts`): the last graph population slice - URL and string entities extracted from jadx decompiles and apktool projects (5k URL / 10k string caps, bare words and boilerplate skipped), each carrying the file and line it first appeared in, with `maps-to` edges to the class of the file it was seen in (resources record the entity but attach to nothing rather than fabricating a class). A URL seen in smali and in decompiled Java converges on one entity. See `docs/ARCHITECTURE.md`
- [x] Pre-build validation (`android.validate`, apktool agent's `validate`): manifest and every `res/` XML checked for well-formedness (unclosed/mismatched tags, unbalanced quotes), empty or truncated smali files flagged, APKs referenced in `apktool.yml` verified to exist - all issues reported at once; `build` runs the same pre-flight so a doomed build fails in seconds, not halfway through a resource cycle. See `docs/AGENTS.md`
- [x] Own-keystore signing (apksigner agent): `keystorePath`/`keystorePass`/`keystoreAlias` payload options sign with a caller-provided keystore instead of the generated debug key; the password lives only in the task payload and the spawned process.
- [x] Split APK / XAPK / APKS handling (`split-bundle.ts`): apktool `decode` extracts a bundle and decodes its `base.apk` (other splits stay beside it); apksigner `sign` signs every APK in a split directory and repacks into an installable `.apks`; `.aab`/`.abb` are flagged as needing Bundletool. See `docs/AGENTS.md`
- [x] Frida module store (`src/modules/frida-modules/module-store.ts`): trace scripts as versioned, reusable workflow assets - `module-save` drafts, a trace via `moduleRef` records provenance on the module, `module-promote` freezes a tested draft into an immutable semver version (patch/minor/major; drafts stay editable for the next iteration), `module-list`/`module-get` read it, and `trace` accepts `"name"` or `"name@version"` instead of raw script text. See `docs/AGENTS.md`
- [x] apk-patch/build/sign traceability + v4 signing (`docs/AGENTS.md`): patch lineage in `.hexforge-patches.json`, build reports `sha256` + `patches`, sign reports `sourceSha256` + optional `.idsig` (v4)
- [x] Frida streaming sessions (`frida-sessions.ts`): capped long-running instrumentation with incremental JSONL event polling, workspace-scoped, restart-safe
- [x] Fan-out over a list of unknown length (Workflow Engine `fanOut` step): a step template cloned once per item of the previous step's result (array result, or an object looked up at `from`), branch-capped, same group semantics - and plain-job resume (`POST /jobs/:id/resume`): a failed job restarted from the beginning with `resumeCount` tracked. See `docs/ARCHITECTURE.md`

- [x] Graph methods and calls edges (`graph/calls-indexer.ts`): the jadx decompile index
  now also parses declared methods into signature-named `method` entities (`native`
  flagged, overloads distinct), resolves call receivers against the artifact's own
  classes (simple names and declared field types) into `calls` edges, and marks
  reflection with self-looped `invokes` edges. Targets outside the artifact are never
  fabricated; comments/strings/keywords are stripped before matching.
- [x] Graph field accesses (`graph/accesses-indexer.ts`): the jadx decompile index
  also brace-matches each method body, resolves bare/`this.` field references
  and receiver chains (declared field types + static class names) into new
  `field` entities with `accesses` edges from the exact method signatures the
  calls indexer emits. Locals are excluded by body ranges, unknown classes are
  never fabricated, and comments/strings are stripped before matching.
  `R.*` resource-name references remain a follow-up (manifest resource
  entities are named `permission:`/`intent:` and cannot be joined reliably).
- [x] Graph runtime events (`graph/runtime-indexer.ts`): a `runtime-events`
  artifact (JSONL hook observations from a Frida-style run) becomes
  `runtime-event` entities, aggregated per unique hook with a `count`
  attribute, with `maps-to` edges to the hooked `method` entity and the
  reached `url` entity when both ends already exist (no fabrication).
  Hook arguments, return values and stack traces are never stored; URL
  query values are dropped. Producers record the artifact kind; the indexer
  is event-driven like every other graph indexer.
- [x] Per-workspace AI provider selection: `PATCH /workspaces/:id/ai-provider` stores a
  workspace-scoped override (built-in or `AI_PROVIDERS_PATH` name, validated at set time
  against everything the AI layer can dispatch on) that applies to that workspace's chat,
  knowledge summarize and `ai` agent calls; `null` clears it back to the global
  `AI_PROVIDER` (`docs/AI.md` documents it).
- [x] Neon/Postgres hosting guide in `docs/SETUP.md`: the Neon free tier end to end -
  pooled connection string, `postgres.schema.sql`, `DATABASE_URL` +
  `STORAGE_BACKEND=postgres`, the `/health` boot check, and the outage/fallback
  behavior spelled out.
- [x] Claim-verification workflow step (`verify-claims` agent): re-runs every finding in a
  workspace (or an explicit id list) through the evidence verifier - artifact exists,
  cited `file:line` is real and in range, graph entity observed in the artifact - and
  with `apply: true` writes the verdict back (`verified`/`partial` -> `confirmed`,
  `unverified` -> stays, `failed` -> `contradicted`). A claim with no checkable evidence
  is flagged, never silently trusted.

- [x] MCP server frontend auth hardening: per-key rate limiting on `/mcp` (`MCP_HTTP_RATE_LIMIT_MAX`/`MCP_HTTP_RATE_LIMIT_WINDOW_MS`, fixed-window, 429 + Retry-After; client IP as the identity without auth), the existing Origin allowlist (`MCP_HTTP_ALLOWED_ORIGINS`) now documented as the CORS story, and an optional append-only audit log of every `/mcp` request (`MCP_HTTP_AUDIT_LOG`, JSON Lines, keys fingerprinted, tool arguments never recorded). See `src/mcp-server/auth-hardening.ts` and `docs/MCP_SERVER.md`
- [x] 1.6.0: custom AI providers via `AI_PROVIDERS_PATH` (file-defined providers with per-call override, alongside the nine built-ins) and a Postgres storage backend (`DATABASE_URL`, Neon works) - see `docs/AI.md` and `docs/SETUP.md`. The storage layer became a `getStorage()` factory, so services no longer import the supabase/local providers directly
- [x] Secret intelligence (`filesystem.scan-secrets` + `graph/secret-indexer.ts`): a 24-detector registry where every hit is scored into a redacted secret candidate (detector, confidence from entropy/context keywords/placeholder shapes, SHA-256 fingerprint, signals) - the secret value itself is never stored anywhere, and candidates land in the knowledge graph as `secret-candidate` entities. See `docs/AGENTS.md`
- [x] Triage front door (`triage` agent): fingerprint-first assessment of an APK or decoded/decompiled project - APKiD fingerprints, manifest (package, SDKs, permissions, exported components), native library inventory per ABI, and Kotlin metadata name recovery for obfuscated classes. Assessment language only, warnings list what couldn't run. See `docs/AGENTS.md`
- [x] Pinned runtime (`Dockerfile.runtime` + `scripts/check-runtime.mjs`): the Gateway plus a reproducible RE toolchain - jadx 1.5.1, apktool 2.7.0, build-tools 34, APKiD 3.2.0, frida-tools 14.13.1 - with a one-command health check for every backend the capability registry declares. See `docs/SETUP.md`
- [x] Workflows: parallel step groups (`{ "parallel": [...] }`, optional `continueOnError`, two to twenty branches) and resuming a failed workflow from the step that stopped it (`POST /workflows/:id/resume`, `hf wf-resume`) - a Gateway restart now leaves the workflow failed at the step it reached and resumable, instead of unexplained. See `docs/ARCHITECTURE.md`
- [x] APK modification (`apktool` patch, `apksigner` sign): replace exact text in a decoded project with a tracked record (`apk-patch` artifact, before/after hashes), rebuild, align and sign with a generated debug key (`signed-apk` artifact), install - as tasks, as a workflow chained with `mergePreviousResult`, or as the `patch_apk_project` and `sign_apk` MCP tools. See `docs/APK_MODIFICATION.md`
- [x] Findings report (`src/report/`): `GET /workspaces/:id/report` and the `get_report` MCP tool produce every finding with its evidence, what produced each artifact (tool versions), the entity it is about and a fresh verification, as JSON, Markdown or SARIF 2.1.0 - no machine paths, never stored. See `docs/ARCHITECTURE.md`
- [x] MT Manager tool names (issue #16): `apkmcp`'s `open`, `outline_class` and `close` use whichever tool name MT's `tools/list` reports (MT renamed them to `mt_apk_workspace_open`, `mt_apk_dex_read_class_outline` and `mt_apk_workspace_delete`), `close` refuses to delete a saved workspace without `force`, and `docs/MT_TOOLS.md` lists all 57 MT tools
- [x] Evidence verification (`src/findings/verifier.ts`): re-checks a finding's cited locations (`file.java:12`) against the artifact's files - the file exists, the line is within it, nothing outside the artifact is read - via `GET /findings/:id/verification` and the `verify_finding` MCP tool (cited graph entities are checked too). Reports only; never changes a finding's status. See `docs/ARCHITECTURE.md`
- [x] MCP tools for the evidence side (`src/mcp-server/`): `list_capabilities`, `list_artifacts`, `list_graph_entities`, `get_graph_entity`, `list_findings`, `create_finding` (always saved as the AI's, evidence validated by the Gateway) and `update_finding`, so an AI client can record findings tied to real artifacts. See `docs/MCP_SERVER.md`
- [x] Typed knowledge graph (`src/graph/`): entities (package, class, method, native function, resource, URL, ...) and directed edges, merged by derived ids so re-reporting never duplicates, with cited artifacts and edge ends validated. Decompiled Java and decoded smali are indexed automatically into packages, classes and `contains` edges (capped at 20,000 classes each), merging into one entity per class; `extends`/`implements` clauses become `inherits` edges between class entities (bare superclass names resolved against the subclass's package, fully-qualified ones kept as written, capped at 40,000 edges). See `docs/ARCHITECTURE.md`
- [x] Evidence-backed findings (`src/findings/`): a claim with `status`, `confidence` and `evidence[]` citing artifacts. Evidence is validated on save (the artifact must exist in the same workspace, and a cited graph entity must have been observed in that artifact) and a finding can't be `confirmed` without any. See `docs/ARCHITECTURE.md`
- [x] Artifact recorder (`src/artifacts/`): finished tasks whose operation declares an output (`jadx.decompile`, `apktool.decode`, `apktool.build`, `apktool.patch`, `apksigner.sign`, `filesystem.scan-secrets`, `frida.trace`, `triage.assess`, plus plugin agents) are recorded as artifacts with the run that produced them and the versions of the backend tools behind it, listed by `GET /workspaces/:id/artifacts`. See `docs/ARCHITECTURE.md`
- [x] Capability registry (`src/capabilities/`): agents can describe what they do (capability ids, operations, payload keys, backends, permissions) through an optional descriptor on `registerAgent`; all ten built-in agents do, and `GET /capabilities` lists them. See `docs/AGENTS.md` and `docs/PLUGINS.md`
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
