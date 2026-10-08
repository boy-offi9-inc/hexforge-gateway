import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpTask } from "../src/core/types.js";

// task-output.ts reads WORKSPACES_ROOT from src/core/config.ts once at import
// time, so each test points it at a fresh temp directory and imports the
// module again after vi.resetModules() (same approach as
// local-storage.provider.test.ts).
type TaskOutputModule = typeof import("../src/modules/mcp/agents/task-output.js");

let root: string;
let output: TaskOutputModule;

const task = (id: string): McpTask => ({
  id,
  workspaceId: "ws1",
  agent: "filesystem",
  operation: "scan-secrets",
  payload: {},
  status: "running",
  createdAt: "",
  updatedAt: "",
});

async function load(workspacesRoot: string) {
  vi.resetModules();
  vi.stubEnv("WORKSPACES_ROOT", workspacesRoot);
  output = await import("../src/modules/mcp/agents/task-output.js");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hexforge-task-output-"));
  await load(root);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("withSavedOutput", () => {
  it("saves the result as JSON named after the task and adds outputPath", async () => {
    const result = { dirPath: "/x", matchCount: 1, matches: [{ file: "a", line: 1 }] };
    const saved = await output.withSavedOutput(task("t1"), "filesystem/scan-secrets", result);

    const expectedPath = path.resolve(root, "ws1", "filesystem", "scan-secrets", "t1.json");
    expect(saved).toEqual({ ...result, outputPath: expectedPath });
    // The file holds the result as it was, without outputPath.
    expect(JSON.parse(await readFile(expectedPath, "utf8"))).toEqual(result);
  });

  it("gives every task its own file, so earlier outputs are never overwritten", async () => {
    const first = await output.withSavedOutput(task("t1"), "frida/traces", { run: 1 });
    const second = await output.withSavedOutput(task("t2"), "frida/traces", { run: 2 });

    expect(first).toHaveProperty("outputPath");
    expect((first as { outputPath: string }).outputPath).not.toBe(
      (second as { outputPath: string }).outputPath,
    );
    const firstFile = (first as { outputPath: string }).outputPath;
    expect(JSON.parse(await readFile(firstFile, "utf8"))).toEqual({ run: 1 });
  });

  it("returns the original result unchanged when the file can't be written", async () => {
    // A regular file where a directory is needed makes mkdir fail.
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "not a directory");
    await load(path.join(blocker, "workspaces"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = { matchCount: 0 };
    const saved = await output.withSavedOutput(task("t1"), "filesystem/scan-secrets", result);

    expect(saved).toEqual({ matchCount: 0 });
    expect(saved).not.toHaveProperty("outputPath");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
