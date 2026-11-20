// Ghidra agent - headless native analysis via analyzeHeadless.
//
// Headless Ghidra is a heavy Java process; these tests verify everything
// the agent does around it: payload validation, launcher resolution, the
// exact execFile invocation (script wiring, env, report path), report
// parsing, and failure surfaces. The Jython post-script itself is only
// exercised against real Ghidra (Dockerfile.runtime pins the version and
// scripts/check-runtime.mjs verifies the install).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(() => undefined, { __esModule: true }),
}));
vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: () => execFileMock,
  };
});

import { ghidraHandler } from "../src/modules/mcp/agents/ghidra.agent.js";
import type { McpTask } from "../src/core/types.js";

// WORKSPACES_ROOT is read by core/config at import time - stub it before
// importing config, into a fresh temp dir, the same pattern apk-patch.test.ts
// uses. Without this, one test's report file satisfies the next test's
// "no report" assertions.
vi.stubEnv("WORKSPACES_ROOT", mkdtempSync(path.join(os.tmpdir(), "hexforge-ghidra-root-")));

function makeTask(payload: Record<string, unknown>, operation = "analyze"): McpTask {
  return {
    id: "t-ghidra",
    kind: "ghidra",
    operation,
    payload,
    // Unique per test - the agent writes its report under
    // WORKSPACES_ROOT/<workspaceId>/ghidra, and a stale report from a
    // previous test would mask "no report" assertions.
    workspaceId: "ws-ghidra-" + Math.random().toString(36).slice(2),
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as McpTask;
}

describe("ghidra agent", () => {
  let tmp: string;
  let originalGhidraHome: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hexforge-ghidra-"));
    originalGhidraHome = process.env.GHIDRA_HOME;
    delete process.env.GHIDRA_HOME;
    execFileMock.mockReset();
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (originalGhidraHome === undefined) delete process.env.GHIDRA_HOME;
    else process.env.GHIDRA_HOME = originalGhidraHome;
  });

  it("rejects a missing filePath", async () => {
    await expect(ghidraHandler(makeTask({}))).rejects.toThrow(/requires a "filePath"/);
  });

  it("rejects a nonexistent file", async () => {
    await expect(ghidraHandler(makeTask({ filePath: "/nope/libdroid.so" }))).rejects.toThrow(
      /File not found/,
    );
  });

  it("rejects unsupported file types", async () => {
    const f = path.join(tmp, "notes.txt");
    writeFileSync(f, "hello");
    await expect(ghidraHandler(makeTask({ filePath: f }))).rejects.toThrow(/Unsupported file type/);
  });

  it("rejects a ghidraHome that is not a Ghidra install", async () => {
    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");
    await expect(ghidraHandler(makeTask({ filePath: f, ghidraHome: tmp }))).rejects.toThrow(
      /does not look like a Ghidra install/,
    );
  });

  it("rejects unknown operations", async () => {
    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");
    await expect(ghidraHandler(makeTask({ filePath: f }, "decompile"))).rejects.toThrow(
      /Unsupported ghidra operation/,
    );
  });

  it("resolves GHIDRA_HOME and invokes analyzeHeadless with the post-script wiring", async () => {
    const fakeHome = path.join(tmp, "ghidra-fake");
    const support = path.join(fakeHome, "support");
    if (!existsSync(support)) {
      // eslint-disable-next-line no-undef
      require("node:fs").mkdirSync(support, { recursive: true });
    }
    writeFileSync(path.join(support, "analyzeHeadless"), "#!/bin/sh\n");
    process.env.GHIDRA_HOME = fakeHome;

    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");

    execFileMock.mockImplementation(async (_file, args, opts) => {
      // Simulate the post-script: write the report where the env points.
      const env = (opts as { env: Record<string, string> }).env;
      const reportPath = env.GHIDRA_REPORT;
      expect(reportPath).toContain(path.join("ghidra", "hexforge-libtest.so.analysis.json"));
      expect(reportPath).toContain("ws-ghidra-");
      writeFileSync(
        reportPath,
        JSON.stringify({
          program: "libtest.so",
          language: "AARCH64:LE:64:v8.0A",
          functionCount: 2,
          reported: 2,
          functions: [
            { name: "Java_com_example_hook", address: "00010000", decompiled: "void f() {}" },
            { name: "sub_100a0", address: "000100a0" },
          ],
        }),
      );
      return { stdout: "analysis done", stderr: "" };
    });

    const result = (await ghidraHandler(makeTask({ filePath: f }))) as {
      program: string;
      language: string;
      functionCount: number;
      functions: Array<{ name: string }>;
    };

    // Launcher came from GHIDRA_HOME
    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toBe(path.join(fakeHome, "support", "analyzeHeadless"));
    expect(args).toContain("-import");
    expect(args).toContain(f);
    expect(args).toContain("-postScript");
    expect(args).toContain("hexforge_dump.java");
    expect((opts as { timeout: number }).timeout).toBeGreaterThan(0);

    expect(result.program).toBe("libtest.so");
    expect(result.language).toContain("AARCH64");
    expect(result.functionCount).toBe(2);
    expect(result.functions[0].name).toBe("Java_com_example_hook");
  });

  it("falls back to `analyzeHeadless` on PATH when GHIDRA_HOME is unset", async () => {
    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");

    execFileMock.mockImplementation(async (_file, args, opts) => {
      writeFileSync(
        (opts as { env: Record<string, string> }).env.GHIDRA_REPORT,
        JSON.stringify({
          program: "libtest.so",
          language: "x86:LE:64",
          functionCount: 1,
          reported: 1,
          functions: [{ name: "entry", address: "0" }],
        }),
      );
      return { stdout: "", stderr: "" };
    });

    await ghidraHandler(makeTask({ filePath: f }));
    expect(execFileMock.mock.calls[0][0]).toBe("analyzeHeadless");
  });

  it("surfaces a friendly install hint when the binary is missing", async () => {
    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");
    execFileMock.mockRejectedValue(
      Object.assign(new Error("spawn analyzeHeadless ENOENT"), { code: "ENOENT" }),
    );
    await expect(ghidraHandler(makeTask({ filePath: f }))).rejects.toThrow(
      /GHIDRA_HOME|ghidra-sre/,
    );
  });

  it("fails clearly when the analysis ran but no report was written", async () => {
    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");
    execFileMock.mockResolvedValue({
      stdout: "INFO  REPORT: Analysis succeeded",
      stderr: "ERROR: post-script failed",
    });
    await expect(ghidraHandler(makeTask({ filePath: f }))).rejects.toThrow(/produced no report/);
  });

  it("flags truncation when the function count exceeds the report cap", async () => {
    const f = path.join(tmp, "libtest.so");
    writeFileSync(f, "elf-bytes");
    execFileMock.mockImplementation(async (_file, _args, opts) => {
      writeFileSync(
        (opts as { env: Record<string, string> }).env.GHIDRA_REPORT,
        JSON.stringify({
          program: "big.so",
          language: "ARM:LE:32",
          functionCount: 5000,
          reported: 2000,
          functions: Array.from({ length: 50 }, (_, i) => ({
            name: `sub_${i}`,
            address: `0x${i}`,
          })),
        }),
      );
      return { stdout: "", stderr: "" };
    });

    const result = (await ghidraHandler(makeTask({ filePath: f }))) as {
      truncated: boolean;
      functionCount: number;
      reportedFunctions: number;
      functions: unknown[];
    };
    expect(result.truncated).toBe(true);
    expect(result.functionCount).toBe(5000);
    expect(result.reportedFunctions).toBe(2000);
    expect(result.functions.length).toBe(50);
  });
});
