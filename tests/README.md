# Unit/integration tests

Run with `npm test` (single run) or `npm run test:watch`. These are plain
[Vitest](https://vitest.dev) tests - no live Gateway instance needed, unlike
`scripts/smoke-test.sh`, which they complement rather than replace:

| | covers | needs |
|---|---|---|
| `scripts/smoke-test.sh` | end-to-end happy paths through a real running Gateway | a live instance (CI starts one) |
| `tests/*.test.ts` | retry/failure logic, concurrency, edge cases | nothing - pure unit tests with mocked dependencies |

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
- **`protocol.test.ts`** - the MCP server's shared JSON-RPC dispatch
  (`src/mcp-server/protocol.ts`, used by both the stdio and Streamable
  HTTP transports): `initialize`/`tools/list`/unknown-method handling,
  notifications correctly producing no response, an unknown tool name
  and a missing `tools/call` "name" param each erroring the *right* way
  (tool result vs. JSON-RPC error - see `docs/MCP_SERVER.md`), a meta
  tool dispatching straight to its `gateway-client.ts` function, an
  agent-mapped tool resolving its workspace by name and forwarding the
  rest of its arguments as the job payload, a failed job surfacing as
  `isError: true` rather than a protocol error, and a thrown/rejected
  gateway call getting caught the same way rather than crashing the
  request.

**Not covered yet**, and still relying on `scripts/smoke-test.sh` or manual
testing: the MCP agents themselves (jadx/apktool/adb/frida/apkid/apkmcp -
all shell out to real binaries or a real device), the two MCP server
*transports*' own framing (`index.ts`'s stdin buffering, `http.ts`'s
routing/auth/Origin-checking - `protocol.test.ts` covers the dispatch
logic underneath both, verified manually end-to-end for each transport
when they were built, but not yet as an automated test), and the API
routes' request validation (a good next target - build the app via
`core/server.ts`'s `buildServer()`, point `DATA_DIR`/`WORKSPACES_ROOT` at a
temp dir the same way `local-storage.provider.test.ts` does, and drive
requests through Fastify's `app.inject()` rather than a real listening
port).

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
  `dotenv/config` (which only fills in keys *absent* from `process.env`)
  repopulate it from a developer's real local `.env`, silently breaking
  the test on their machine.
- **`protocol.test.ts`** `vi.mock()`s `gateway-client.js` - the one
  module `protocol.ts` actually talks to the Gateway through - the same
  one-layer-down approach as the Job/Workflow Engine tests. No env/module
  reset dance needed here: unlike the modules above, nothing in
  `protocol.ts` reads config at import time.
