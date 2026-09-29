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
  },
});
