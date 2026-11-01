import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyTextPatch } from "../src/modules/mcp/agents/apk-patch.js";
import type { McpTask } from "../src/core/types.js";

describe("applyTextPatch", () => {
  it("replaces a single exact match and reports where it was", () => {
    const result = applyTextPatch("a\nb\nc = 1\n", "c = 1", "c = 2");

    expect(result.text).toBe("a\nb\nc = 2\n");
    expect(result.replacements).toBe(1);
    expect(result.changes).toEqual([{ line: 3, before: "c = 1", after: "c = 2" }]);
  });

  it("refuses an ambiguous edit unless told to replace all of them", () => {
    const text = "x\ny\nx\n";

    expect(() => applyTextPatch(text, "x", "z")).toThrow(/appears 2 times/);
    const all = applyTextPatch(text, "x", "z", true);
    expect(all.text).toBe("z\ny\nz\n");
    expect(all.replacements).toBe(2);
    expect(all.changes.map((c) => c.line)).toEqual([1, 3]);
  });

  it("fails when the text isn't there, or when there is nothing to look for", () => {
    expect(() => applyTextPatch("abc", "zzz", "y")).toThrow(/not found/);
    expect(() => applyTextPatch("abc", "", "y")).toThrow(/must not be empty/);
  });

  it("matches plain text, not patterns, and doesn't count overlapping matches twice", () => {
    expect(applyTextPatch("a.*b", ".*", "-").text).toBe("a-b");
    const overlapping = applyTextPatch("aaa", "aa", "b");
    expect(overlapping.text).toBe("ba");
    expect(overlapping.replacements).toBe(1);
  });

  it("can delete text, and keeps a record of at most 50 changes", () => {
    expect(applyTextPatch("keep drop keep", " drop", "").text).toBe("keep keep");

    const many = applyTextPatch("x\n".repeat(80), "x", "y", true);
    expect(many.replacements).toBe(80);
    expect(many.changes).toHaveLength(50);
  });

  it("shortens long snippets in the record but replaces the full text", () => {
    const long = "q".repeat(500);
    const result = applyTextPatch(`<${long}>`, long, "r");

    expect(result.text).toBe("<r>");
    expect(result.changes[0]?.before.length).toBeLessThan(250);
  });
});

// The handler runs against a real decoded-project-shaped directory. It reads
// WORKSPACES_ROOT (for the saved record) from config at import time, so each
// test points it at a fresh temp directory and imports the agent again.
describe("apktool patch operation", () => {
  let root: string;
  let project: string;
  let handler: (task: McpTask) => Promise<unknown>;

  const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
  const task = (payload: Record<string, unknown>): McpTask =>
    ({
      id: "t1",
      workspaceId: "ws1",
      agent: "apktool",
      operation: "patch",
      payload,
      status: "running",
      createdAt: "",
      updatedAt: "",
    }) as McpTask;
  const patch = (payload: Record<string, unknown>) =>
    handler(task({ projectDir: project, ...payload })) as Promise<Record<string, any>>;

  // A patch against the test project that should be refused.
  const refused = (payload: Record<string, unknown>, message?: RegExp) =>
    expect(patch(payload)).rejects.toThrow(message);
  // The same, without the project filled in.
  const refusedRaw = (payload: Record<string, unknown>, message: RegExp) =>
    expect(handler(task(payload))).rejects.toThrow(message);

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hexforge-patch-"));
    project = path.join(root, "project");
    await mkdir(path.join(project, "smali", "com", "acme"), { recursive: true });
    await writeFile(path.join(project, "apktool.yml"), "version: 2\n");
    await writeFile(
      path.join(project, "smali", "com", "acme", "Login.smali"),
      '.class public Lcom/acme/Login;\nconst-string v0, "http://api"\n',
    );
    await writeFile(path.join(project, "AndroidManifest.xml"), '<manifest debuggable="false"/>');
    vi.resetModules();
    vi.stubEnv("WORKSPACES_ROOT", path.join(root, "workspaces"));
    handler = (await import("../src/modules/mcp/agents/apktool.agent.js")).apktoolHandler;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("edits the file and says what changed, with before and after hashes", async () => {
    const file = path.join(project, "smali", "com", "acme", "Login.smali");
    const before = await readFile(file);

    const result = await patch({
      file: "smali/com/acme/Login.smali",
      find: "http://api",
      replace: "https://api",
    });

    const after = await readFile(file, "utf8");
    expect(after).toContain('"https://api"');
    expect(result).toMatchObject({
      patchedFile: "smali/com/acme/Login.smali",
      replacements: 1,
      sha256Before: sha(before),
      sha256After: sha(after),
      projectDir: path.resolve(project),
    });
  });

  it("saves a record with no machine paths, and returns its path as outputPath", async () => {
    const result = await patch({ file: "AndroidManifest.xml", find: "false", replace: "true" });

    const record = JSON.parse(await readFile(result.outputPath, "utf8"));
    expect(record).toMatchObject({ patchedFile: "AndroidManifest.xml", replacements: 1 });
    expect(record).not.toHaveProperty("projectDir");
    expect(JSON.stringify(record)).not.toContain(root);
  });

  it("returns none of its own input keys, so a merge into the next step is safe", async () => {
    const result = await patch({ file: "AndroidManifest.xml", find: "false", replace: "true" });

    for (const key of ["file", "find", "replace", "all"]) expect(result).not.toHaveProperty(key);
  });

  it("chains: a second patch can take the first one's result merged into its payload", async () => {
    const first = await patch({ file: "AndroidManifest.xml", find: "false", replace: "true" });
    const second = (await handler(
      task({ file: "smali/com/acme/Login.smali", find: "http://", replace: "https://", ...first }),
    )) as Record<string, any>;

    expect(second.patchedFile).toBe("smali/com/acme/Login.smali");
    expect(await readFile(path.join(project, "AndroidManifest.xml"), "utf8")).toContain("true");
  });

  it("takes the project from outputDir (a decode result) or inputDir too", async () => {
    for (const key of ["outputDir", "inputDir"]) {
      const result = (await handler(
        task({ [key]: project, file: "AndroidManifest.xml", find: "false", replace: "true" }),
      )) as Record<string, any>;
      expect(result.replacements).toBe(1);
      await writeFile(path.join(project, "AndroidManifest.xml"), '<manifest debuggable="false"/>');
    }
  });

  it("leaves the file alone when the text is missing or matches more than once", async () => {
    const file = path.join(project, "smali", "com", "acme", "Login.smali");
    const before = await readFile(file, "utf8");

    const smali = "smali/com/acme/Login.smali";
    await refused({ file: smali, find: "nope", replace: "x" }, /not found/);
    await refused({ file: smali, find: "c", replace: "x" }, /appears \d+ times/);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("refuses paths that leave the project: parent, absolute and symlinked", async () => {
    await writeFile(path.join(root, "outside.txt"), "secret");
    await symlink(root, path.join(project, "link"));

    for (const file of ["../outside.txt", path.join(root, "outside.txt"), "link/outside.txt"]) {
      await refused({ file, find: "secret", replace: "x" });
    }
    expect(await readFile(path.join(root, "outside.txt"), "utf8")).toBe("secret");
  });

  it("refuses binary files, directories and files over the size limit", async () => {
    await writeFile(path.join(project, "classes.bin"), Buffer.from([1, 2, 0, 3]));
    await writeFile(path.join(project, "big.xml"), "x".repeat(5 * 1024 * 1024 + 1));

    await refused({ file: "classes.bin", find: "a", replace: "b" }, /binary/);
    await refused({ file: "smali", find: "a", replace: "b" }, /Not a file/);
    await refused({ file: "big.xml", find: "x", replace: "y" }, /larger than/);
  });

  it("insists on a decoded project and on every input", async () => {
    await refusedRaw({ projectDir: root, file: "a", find: "a", replace: "b" }, /apktool project/);
    await refusedRaw({ file: "a", find: "a", replace: "b" }, /projectDir/);
    await refused({ find: "a", replace: "b" }, /"file"/);
    await refused({ file: "AndroidManifest.xml", find: "a" }, /"find" and "replace"/);
    await refused({ file: "nope.xml", find: "a", replace: "b" }, /No such file/);
  });
});
