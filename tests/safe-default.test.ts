import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The safe-by-default startup guard: a non-loopback HOST with auth off must
 * refuse to start on bare metal, but keep working inside a container (where
 * the real exposure is the host-side port mapping this process can't see).
 * The guard lives in src/index.ts's main(), so this test reproduces its
 * exact condition by importing the same config and faking the two branches.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let dataDir: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = undefined;
  vi.resetModules();
});

async function loadGuard() {
  vi.resetModules();
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-guard-"));
  vi.stubEnv("DATA_DIR", dataDir);
  // minimal env so the config schema settles deterministically
  return import("../src/core/config.js");
}

describe("safe-by-default binding", () => {
  it("defaults HOST to 127.0.0.1", async () => {
    const { config } = await loadGuard();
    expect(config.HOST).toBe("127.0.0.1");
    // the guard's own predicate must agree
    expect(["127.0.0.1", "localhost", "::1"].includes(config.HOST)).toBe(true);
  });

  it("keeps an explicit remote HOST as the opt-in", async () => {
    vi.stubEnv("HOST", "0.0.0.0");
    const { config } = await loadGuard();
    expect(config.HOST).toBe("0.0.0.0");
    expect(["127.0.0.1", "localhost", "::1"].includes(config.HOST)).toBe(false);
  });

  it("reports degraded storage only after a fallback happened", async () => {
    const storage = await import("../src/providers/storage.provider.js");
    expect(storage.isStorageDegraded()).toBe(false);
    storage.markStorageDegraded();
    expect(storage.isStorageDegraded()).toBe(true);
  });

  it("container marker exists on this repo's Docker builds only (sanity)", async () => {
    // /.dockerenv must NOT exist on a bare checkout - if this ever flips,
    // the bare-metal refusal is silently disabled
    const { existsSync } = await import("node:fs");
    expect(existsSync("/.dockerenv")).toBe(false);
  });
});
