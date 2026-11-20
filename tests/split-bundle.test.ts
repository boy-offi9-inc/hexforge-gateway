import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bundleKind, extractBundle, repackBundle } from "../src/modules/mcp/agents/split-bundle.js";

describe("bundleKind", () => {
  it("classifies by extension and layout", () => {
    expect(bundleKind("app.xapk")).toBe("xapk");
    expect(bundleKind("bundle.APKS")).toBe("apks");
    expect(bundleKind("app.aab")).toBeNull(); // needs bundletool, not zip tooling
  });
});

// Real zip/unzip round-trip (both binaries exist on this host; skipped when absent).
describe("extract + repack round-trip", () => {
  let dir: string;
  let toolsAvailable = true;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hexforge-bundle-"));
    toolsAvailable = await import("node:util").then(async (util) => {
      const { promisify } = util;
      const exec = promisify((await import("node:child_process")).exec);
      try {
        await exec("which unzip && which zip");
        return true;
      } catch {
        return false;
      }
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("extracts a zip-shaped bundle and repacks it byte-differently but list-identically", async () => {
    if (!toolsAvailable) return;
    // build a fake bundle with the real zip tool
    const src = path.join(dir, "bundle-src");
    await mkdir(src, { recursive: true });
    await writeFile(path.join(src, "base.apk"), "fake base");
    await writeFile(path.join(src, "split_config.arm64_v8a.apk"), "fake split");
    await writeFile(path.join(src, "manifest.json"), "{}");
    const bundle = path.join(dir, "app.xapk");
    await repackBundle(src, bundle);

    expect(bundleKind(bundle)).toBe("xapk");
    const dest = path.join(dir, "extracted");
    const { files, manifest } = await extractBundle(bundle, dest);
    expect(manifest).toBeDefined();
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      "base.apk",
      "manifest.json",
      "split_config.arm64_v8a.apk",
    ]);
    // a directory with base.apk classifies as a split-dir
    expect(bundleKind(dest)).toBe("split-dir");

    // repack the extracted dir again; contents round-trip
    const again = path.join(dir, "again.apks");
    await repackBundle(dest, again);
    const dest2 = path.join(dir, "extracted2");
    const { files: files2 } = await extractBundle(again, dest2);
    expect(files2.map((f) => path.basename(f)).sort()).toEqual([
      "base.apk",
      "manifest.json",
      "split_config.arm64_v8a.apk",
    ]);
  });

  it("gives a clear error when unzip is missing", async () => {
    // simulate a missing binary by pointing PATH at an empty dir
    vi.resetModules();
    vi.stubEnv("PATH", dir);
    const { extractBundle: extract } = await import("../src/modules/mcp/agents/split-bundle.js");
    const fake = path.join(dir, "f.xapk");
    await writeFile(fake, "not a zip");
    await expect(extract(fake, path.join(dir, "out"))).rejects.toThrow(/unzip is not installed/);
    vi.unstubAllEnvs();
  });
});
