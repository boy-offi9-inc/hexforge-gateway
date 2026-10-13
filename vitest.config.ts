import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Each test file gets its own module registry (see tests/README.md on
    // why local-storage.provider.test.ts and job-engine.test.ts both rely
    // on that), which is Vitest's "forks" pool default - set explicitly
    // here so it doesn't silently change if Vitest's default ever does.
    pool: "forks",
    // Many tests reload their modules in beforeEach (vi.resetModules() plus
    // dynamic imports), which re-transforms the module graph every time.
    // That is quick on a desktop but can pass Vitest's 5 s test / 10 s hook
    // defaults on a phone (Termux) while the whole suite runs in parallel.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
