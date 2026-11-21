import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpTask } from "../src/core/types.js";

// "build" shells out to apktool, so node's execFile is replaced with a fake that
// records what it was asked to run. What's under test is which project directory
// the operation takes (so a workflow can chain decode -> patch -> build), not apktool.
let root: string;
let project: string;
let calls: { file: string; args: string[] }[];
let handler: (task: McpTask) => Promise<unknown>;

const build = (payload: Record<string, unknown>) =>
  handler({
    id: "t1",
    workspaceId: "ws1",
    agent: "apktool",
    operation: "build",
    payload,
    status: "running",
    createdAt: "",
    updatedAt: "",
  } as McpTask) as Promise<Record<string, any>>;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hexforge-build-"));
  project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "apktool.yml"), "version: 2\n");
  await writeFile(
    path.join(project, "AndroidManifest.xml"),
    "<manifest><application /></manifest>",
  );
  calls = [];

  vi.resetModules();
  vi.stubEnv("WORKSPACES_ROOT", path.join(root, "workspaces"));
  vi.doMock("node:child_process", () => ({
    execFile: vi.fn((file: string, args: string[], _o: unknown, cb: (...a: unknown[]) => void) => {
      calls.push({ file, args });
      // the real apktool writes the output APK; the fake does too so the
      // traceability fields (sha256) can be computed
      const outIdx = args.indexOf("-o");
      if (outIdx !== -1) {
        writeFileSync(args[outIdx + 1], "fake-apk-bytes");
      }
      cb(null, { stdout: "Built apk", stderr: "" });
    }),
  }));
  handler = (await import("../src/modules/mcp/agents/apktool.agent.js")).apktoolHandler;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  await rm(root, { recursive: true, force: true });
});

describe("apktool build", () => {
  it("builds the project given as inputDir, to rebuilt.apk in the workspace", async () => {
    const result = await build({ inputDir: project });

    expect(calls[0]?.file).toBe("apktool");
    expect(calls[0]?.args.slice(0, 2)).toEqual(["b", path.resolve(project)]);
    expect(result.outputPath).toBe(
      path.join(root, "workspaces", "ws1", "apktool", "build", "rebuilt.apk"),
    );
    expect(result.signed).toBe(false);
  });

  it("also takes the project from projectDir (patch) or outputDir (decode)", async () => {
    for (const key of ["projectDir", "outputDir"]) {
      calls.length = 0;
      await build({ [key]: project });
      expect(calls[0]?.args[1], key).toBe(path.resolve(project));
    }
  });

  it("prefers inputDir when several are given", async () => {
    const other = path.join(root, "other");
    await mkdir(other);
    await writeFile(path.join(other, "apktool.yml"), "version: 2\n");
    await writeFile(
      path.join(other, "AndroidManifest.xml"),
      "<manifest><application /></manifest>",
    );

    await build({ inputDir: project, outputDir: other });

    expect(calls[0]?.args[1]).toBe(path.resolve(project));
  });

  it("still insists on a decoded project", async () => {
    await expect(build({})).rejects.toThrow(/requires "inputDir"/);
    await expect(build({ inputDir: root })).rejects.toThrow(/apktool project/);
  });

  it("reports sha256 and no patch lineage for an unpatched project", async () => {
    const result = await build({ inputDir: project });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.patchCount).toBe(0);
    expect(result.patches).toBeUndefined();
  });

  it("carries the patch lineage into the build result", async () => {
    await writeFile(
      path.join(project, ".hexforge-patches.json"),
      JSON.stringify([
        {
          taskId: "t0",
          patchedFile: "smali/com/acme/A.smali",
          replacements: 1,
          sha256After: "ab",
          at: "2026-11-21T00:00:00Z",
        },
        {
          taskId: "t0b",
          patchedFile: "res/values/strings.xml",
          replacements: 2,
          sha256After: "cd",
          at: "2026-11-21T00:01:00Z",
        },
      ]),
    );
    const result = await build({ inputDir: project });
    expect(result.patchCount).toBe(2);
    expect(result.patches.map((x: { patchedFile: string }) => x.patchedFile)).toEqual([
      "smali/com/acme/A.smali",
      "res/values/strings.xml",
    ]);
  });
});
