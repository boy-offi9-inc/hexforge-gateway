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

**Not covered yet**, and still relying on `scripts/smoke-test.sh` or manual
testing: the MCP agents themselves (jadx/apktool/adb/frida/apkid/apkmcp -
all shell out to real binaries or a real device), the AI provider layer's
HTTP request/response handling per provider (a good next target - mock
`fetch` and assert each provider's request shape and how it handles a
malformed/error response), and the API routes' request validation.

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
