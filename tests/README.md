# Unit/integration tests

Run with `npm test` (single run) or `npm run test:watch`. These are plain
[Vitest](https://vitest.dev) tests - no live Gateway instance needed, unlike
`scripts/smoke-test.sh`, which they complement rather than replace:

|                         | covers                                                | needs                                              |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `scripts/smoke-test.sh` | end-to-end happy paths through a real running Gateway | a live instance (CI starts one)                    |
| `tests/*.test.ts`       | retry/failure logic, concurrency, edge cases          | nothing - pure unit tests with mocked dependencies |

## What's covered so far

- **`job-engine.test.ts`** - JobEngine's retry logic: succeeds first try,
  retries then succeeds, exhausts `maxAttempts` and fails, and a
  regression test for the fast-fail race (a task that's already terminal
  by the time `dispatch()` resolves must resolve synchronously via
  `getTask()`, without a stray event listener left registered).
- **`workflow-engine.test.ts`** - WorkflowEngine's step sequencing: runs
  every step and merges `mergePreviousResult` correctly, stops the whole
  workflow on a step failure without dispatching later steps, and the
  same already-terminal-by-the-time-we-check race as above, one layer up
  (a step's Job, not a Job's Task).
- **`local-storage.provider.test.ts`** - the local JSON file store:
  upsert/get/list/delete/find round-trip correctly, writes actually land
  on disk (not just in the in-memory cache), collections stay independent
  of each other, and - the specific race its own module comment calls
  out - concurrent upserts/deletes on one collection don't clobber each
  other.
- **`ai-provider.test.ts`** - the AI provider layer, with `fetch` mocked:
  for Anthropic, the shared OpenAI-compatible shape (via Groq, which
  Groq/OpenAI/DeepSeek/xAI/Mistral/openai-compatible all reuse), Gemini,
  and Ollama - each provider's "not configured" error, exact request
  shape (URL, headers, body), successful-response parsing, a non-ok HTTP
  response surfaced with status + body, and a malformed/empty response
  producing a clear error rather than returning garbage. Groq and Ollama
  also cover a network-level `fetch` rejection getting wrapped in a
  friendlier reachability message.
- **`capability-registry.test.ts`** - the capability registry: providers ordered by priority, all of an adapter's operations grouped per capability, fallback when a backend's availability probe says no (or throws), malformed capability ids and duplicate operation names rejected, and replace/unregister. Pure unit test, no mocks - the registry has no dependencies.
- **`builtin-capabilities.test.ts`** - the built-in descriptors are plain data, so this needs no mocks: all eight agents are described and pass registry validation, frida's push/start/stop-server operations group under one capability, and `outputs` is only declared for the operations whose result is a tracked path (`jadx.decompile`, `apktool.decode`, `apktool.build`).
- **`capability-routes.test.ts`** - `GET /capabilities` on a bare Fastify instance (same approach as `api-routes.test.ts`, without its mocking, since the route only reads the registry singleton): providers come back ordered by priority with their operation names, and the `isAvailable` probe never reaches the JSON.
- **`artifact-recorder.test.ts`** - `extractArtifacts` is a pure function (task + registry in, artifact inputs out), so no storage, events or mocks: a directory from `outputDir`, a file from `outputPath`, and nothing for failed tasks, unknown agents, operations declaring no or several outputs, or results without a usable path.
- **`artifact-service.test.ts`** - real local storage in a throwaway `DATA_DIR` with a fresh module graph per test: record/get/list per workspace, the `kind` filter, and updating in place (same id and `createdAt`, new `source`) when the same kind is produced at the same path again.
- **`artifact-routes.test.ts`** - `GET /workspaces/:id/artifacts` (kind filter passed through, 404 unknown workspace, 400 empty `kind`) and `GET /artifacts/:artifactId` (200/404), on a bare Fastify instance with both services mocked.
- **`protocol.test.ts`** - the MCP server's shared JSON-RPC dispatch
  (`src/mcp-server/protocol.ts`, used by both the stdio and Streamable
  HTTP transports): `initialize`/`tools/list`/unknown-method handling,
  notifications correctly producing no response, an unknown tool name
  and a missing `tools/call` "name" param each erroring the _right_ way
  (tool result vs. JSON-RPC error - see `docs/MCP_SERVER.md`), a meta
  tool dispatching straight to its `gateway-client.ts` function, an
  agent-mapped tool resolving its workspace by name and forwarding the
  rest of its arguments as the job payload, a failed job surfacing as
  `isError: true` rather than a protocol error, and a thrown/rejected
  gateway call getting caught the same way rather than crashing the
  request.
- **`inbox-watcher.test.ts`** - the inbox watcher (`docs/INBOX.md`)
  against real temp directories: a file isn't claimed on its first
  sighting, only once a later poll sees it byte-for-byte unchanged; it
  then gets moved into `<WORKSPACES_ROOT>/<workspaceId>/inbox/` (and is
  gone from the inbox dir) with exactly one `source: "inbox"` knowledge
  entry written; a file that's still growing between polls (still being
  written/copied) is correctly left unclaimed until it actually
  stabilizes; a file removed before it ever stabilizes is cleaned up
  without being claimed or throwing; a missing inbox directory is
  created rather than erroring; non-`.apk` files are ignored entirely;
  and `listInboxApks()` reflects real directory contents rather than any
  separately-tracked state.

- **`api-routes.test.ts`** - the REST routes' request validation, on a
  bare Fastify instance driven through `app.inject()` (no real port):
  every zod schema's rejection paths return 400 _without_ touching the
  service (empty/missing fields, `maxAttempts` at 0 / above 10 /
  non-integer / a string, empty workflow `steps`, a bad `?type=` filter,
  the PATCH "at least one field" refinement), unknown workspace/job/
  workflow/entry ids return 404, valid requests reach the right service
  with the right arguments and the right status (201/202/204), the
  chat/summarize endpoints return 503 when the AI provider isn't
  configured (checked _before_ body validation, so even an invalid body
  gets 503) and 502 with the provider's message when it throws, and the
  chat transcript comes back oldest-first with `source` mapped to
  `role`.
- **`auth.test.ts`** - `registerAuth()`: a no-op when disabled; when
  enabled, 401 with no key or a wrong key, accepted via `Authorization:
Bearer` or `X-API-Key`, any one of several configured keys works, the
  Bearer key takes precedence over `X-API-Key` (same as
  `mcp-server/http.ts`), `GET /health` is exempt but other methods and
  routes aren't.

- **`tools.test.ts`** - the MCP tool definitions (`src/mcp-server/tools.ts`),
  which are pure data so nothing is mocked: no duplicate names, every
  description long enough to say what a tool returns, every parameter
  documented, `required` only naming real parameters, every tool
  annotated (write tools also declare `destructiveHint`/`idempotentHint`,
  read-only ones don't), and the set of destructive tools pinned to
  exactly the four that can change the device or prior work. Guards the
  things Glama's quality score marks down; it can't check that the prose
  is still _true_, only that it's present.

- **`cli.test.ts`** - the `hf` CLI's pure parts (`scripts/hf/*.mjs`, plain
  ESM with no build step): measuring/truncating/wrapping that ignores ANSI
  codes and counts CJK as two cells; box rows all exactly the terminal
  width; cards and markdown never overflowing, down to 24 columns;
  **ASCII mode never emitting a non-ASCII byte** across every component;
  color-off dropping color but keeping layout; `detectCaps` (TTY vs pipe,
  `--json`/`--plain`/`HF_PLAIN`, `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`,
  locale and `HF_ASCII`); argument and payload parsing (`key=value` is
  never type-guessed, `key:=json` is); the state file (round trip, other
  keys preserved, bash-sourceable, escaping); and the HTTP client mapping
  statuses and failures to error kinds, including zod validation bodies.
  Needs no mocks - the modules take their inputs as parameters.

- **`console-ui.test.ts`** - the Gateway's own terminal output
  (`src/core/console-ui.ts`), all pure functions fed inputs directly: when it
  goes pretty (`LOG_FORMAT`, TTY vs pipe, `TERM=dumb`, `NO_COLOR`/`FORCE_COLOR`,
  locale/`HF_ASCII`); the listen addresses for a wildcard vs specific bind,
  including the numeric address family older Node 18 builds report; the banner
  fitting every width from 24 to 100 columns, each warning firing only in its
  situation (auth requested but no keys, open port reachable from the network,
  unconfigured AI) and staying quiet otherwise, ASCII mode emitting no
  non-ASCII; and the pino stream - a request pair becoming one line, Fastify's
  per-interface "Server listening" lines dropped, a polling burst collapsing
  to one line plus a summary, the summary flushing _before_ the next
  unrelated line, lines split across writes reassembling, non-JSON passing
  through, and every output fitting its width. The plain-mode `notice()`
  format is pinned to exactly `[tag] message`, since logs may be grepped.

**Not covered yet**, and still relying on `scripts/smoke-test.sh` or manual
testing: the MCP agents themselves (jadx/apktool/adb/frida/apkid/apkmcp -
all shell out to real binaries or a real device), and the two MCP server
_transports_' own framing (`index.ts`'s stdin buffering, `http.ts`'s
routing/auth/Origin-checking - `protocol.test.ts` covers the dispatch
logic underneath both, verified manually end-to-end for each transport
when they were built, but not yet as an automated test), and the `hf` CLI's
interactive parts - the live job spinner, the in-place workflow redraw, the
readline chat REPL, and Ctrl+C handling - which need a real terminal; those
were exercised by hand against a fake Gateway inside a pseudo-terminal at
several widths (50 / 40 / 30 columns, ASCII and `NO_COLOR` modes) rather
than as an automated test. `root.routes.ts`
and `plugin.routes.ts` (a cheat-sheet and a one-line introspection route)
also have no dedicated test.

## Why the mocking looks the way it does

- **`job-engine.test.ts`** / **`workflow-engine.test.ts`** `vi.mock()` the
  module one layer down (`orchestrator.js`, `job-engine.js` respectively)
  and drive state transitions by emitting real events on the real
  `eventBus` - that's the actual seam these engines communicate through in
  production (see `docs/ARCHITECTURE.md`), so it's what a test should
  drive too, rather than reaching into private state.
- **`local-storage.provider.test.ts`** sets `DATA_DIR` via `vi.stubEnv()`
  and calls `vi.resetModules()` before every dynamic `import()` of the
  module under test. `DATA_DIR` and the module's `collectionCache` are
  both computed/created once at import time (see the module's own doc
  comment), so re-importing fresh is what actually gets a clean slate per
  test rather than sharing state across them.
- **`ai-provider.test.ts`** stubs global `fetch` with `vi.stubGlobal()`
  and, like `local-storage.provider.test.ts`, re-imports the module fresh
  per test (`AI_PROVIDER` and every `*_API_KEY`/`*_MODEL` are also fixed
  at config import time). "Not configured" cases stub the relevant env
  var to `""` rather than deleting it - deleting would let
  `dotenv/config` (which only fills in keys _absent_ from `process.env`)
  repopulate it from a developer's real local `.env`, silently breaking
  the test on their machine.
- **`protocol.test.ts`** `vi.mock()`s `gateway-client.js` - the one
  module `protocol.ts` actually talks to the Gateway through - the same
  one-layer-down approach as the Job/Workflow Engine tests. No env/module
  reset dance needed here: unlike the modules above, nothing in
  `protocol.ts` reads config at import time.
- **`inbox-watcher.test.ts`** combines both patterns above: `vi.mock()`s
  `workspace.service.js`/`knowledge.service.js` one layer down (same as
  `protocol.test.ts`), _and_ sets `APK_INBOX_DIR`/`WORKSPACES_ROOT` via
  `vi.stubEnv()` + `vi.resetModules()` per test against real temp
  directories (same as `local-storage.provider.test.ts`) - the watcher
  reads both config vars at import time and does real filesystem moves,
  so it needed the isolation both existing patterns handle separately.
- **`api-routes.test.ts`** / **`auth.test.ts`** build a bare Fastify
  instance rather than calling `buildServer()` - that wires up the
  websocket plugin, auth, the plugin loader, and the knowledge indexer,
  none of which is what a route-validation test is about. Services are
  mocked one layer down with `vi.doMock()` inside a helper (rather than a
  hoisted `vi.mock()`) so each test can get a fresh module graph with
  the value it needs - `ai.service`'s `isAiConfigured` is a plain exported
  constant, so covering both its 200 and 503 paths means building the app
  twice with different values, and `auth.ts` reads `apiKeys` /
  `isAuthEffectivelyEnabled` from config at import time. `config.js` is
  mocked too, rather than driven via env vars, since the routes only need
  three or four of its exports.
