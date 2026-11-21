import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpTask } from "../src/core/types.js";

// inject-gadget is pure file work (no external binary), so the tests run it
// for real against a minimal decoded project: manifest + one application
// class in smali. What's checked is the smali surgery, the .so placement,
// the gadget config, the lineage entry and the refusal paths.
let root: string;
let project: string;
let handler: (task: McpTask) => Promise<Record<string, any>>;

const MANIFEST = `<manifest package="com.acme"><application android:name="com.acme.App" /></manifest>`;

const APP_SMALI = `.class public Lcom/acme/App;
.super Landroid/app/Application;

.method public constructor <init>()V
    .locals 0

    invoke-super {p0}, Landroid/app/Application;-><init>()V

    return-void
.end method

.method public onCreate(Landroid/os/Bundle;)V
    .locals 1

    invoke-super {p0, p1}, Landroid/app/Application;->onCreate(Landroid/os/Bundle;)V

    return-void
.end method
`;

const run = (payload: Record<string, unknown>) =>
  handler({
    id: "t1",
    workspaceId: "ws1",
    agent: "apktool",
    operation: "inject-gadget",
    payload,
    status: "running",
    createdAt: "",
    updatedAt: "",
  } as McpTask);

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hexforge-gadget-"));
  project = path.join(root, "project");
  await mkdir(path.join(project, "smali", "com", "acme"), { recursive: true });
  await mkdir(path.join(project, "smali_classes2", "com", "other"), { recursive: true });
  await writeFile(path.join(project, "apktool.yml"), "version: 2\n");
  await writeFile(path.join(project, "AndroidManifest.xml"), MANIFEST);
  await writeFile(path.join(project, "smali", "com", "acme", "App.smali"), APP_SMALI);
  await writeFile(path.join(project, "smali_classes2", "com", "other", "X.smali"), ".class\n");

  vi.resetModules();
  vi.stubEnv("WORKSPACES_ROOT", path.join(root, "workspaces"));
  handler = (await import("../src/modules/mcp/agents/apktool.agent.js")).apktoolHandler as never;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const gadget = async () => {
  const p = path.join(root, "gadget.so");
  await writeFile(p, "fake-gadget-elf-bytes");
  return p;
};

describe("apktool inject-gadget", () => {
  it("copies the gadget .so into lib/<abi> and reports the surgery", async () => {
    const gp = await gadget();
    const result = await run({ projectDir: project, gadgetPath: gp });

    const so = path.join(project, "lib", "arm64-v8a", "libfrida-gadget.so");
    expect(existsSync(so)).toBe(true);
    expect(result.gadgetTarget).toBe(so);
    expect(result.entryClass).toBe("com.acme.App");
    expect(result.smaliFile).toBe("smali/com/acme/App.smali");
    expect(result.insertMethod).toBe("onCreate");
    expect(result.next).toMatch(/build/);
  });

  it("inserts a loadLibrary pair at the top of onCreate and bumps .locals", async () => {
    const gp = await gadget();
    await run({ projectDir: project, gadgetPath: gp });

    const { readFile } = await import("node:fs/promises");
    const text = String(
      await readFile(path.join(project, "smali", "com", "acme", "App.smali"), "utf8"),
    );
    const onCreate = text.slice(text.indexOf(".method public onCreate"));
    expect(onCreate).toContain(".locals 2");
    expect(onCreate.indexOf('const-string v1, "frida-gadget"')).toBeLessThan(
      onCreate.indexOf("invoke-super"),
    );
    expect(onCreate).toContain(
      "invoke-static {v1}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V",
    );
    // the untouched constructor keeps .locals 0
    const init = text.slice(text.indexOf(".method public constructor"));
    expect(init).toContain(".locals 0");
  });

  it("falls back to the constructor when there is no onCreate", async () => {
    const gp = await gadget();
    await writeFile(
      path.join(project, "smali", "com", "acme", "App.smali"),
      APP_SMALI.replace(/\.method public onCreate[\s\S]*\.end method\n/, ""),
    );
    const result = await run({ projectDir: project, gadgetPath: gp });
    expect(result.insertMethod).toBe("<init>");
  });

  it("writes the gadget config when a scriptPath is given", async () => {
    const gp = await gadget();
    const result = await run({
      projectDir: project,
      gadgetPath: gp,
      scriptPath: "/data/local/tmp/hook.js",
    });
    expect(result.configPath).toBe(
      path.join(project, "lib", "arm64-v8a", "libfrida-gadget.config.so"),
    );
    const config = JSON.parse(
      String(await (await import("node:fs/promises")).readFile(result.configPath, "utf8")),
    ) as { interaction: { type: string; path: string } };
    expect(config.interaction).toEqual({
      type: "script",
      path: "/data/local/tmp/hook.js",
    });
  });

  it("records the injection in the project's patch lineage", async () => {
    const gp = await gadget();
    await run({ projectDir: project, gadgetPath: gp });
    const lineage = JSON.parse(
      String(
        await (
          await import("node:fs/promises")
        ).readFile(path.join(project, ".hexforge-patches.json"), "utf8"),
      ),
    ) as { taskId: string; patchedFile: string }[];
    expect(lineage).toHaveLength(1);
    expect(lineage[0].taskId).toBe("t1");
    expect(lineage[0].patchedFile).toContain("libfrida-gadget.so");
  });

  it("takes entryClass explicitly and finds it in smali_classes2", async () => {
    const gp = await gadget();
    await writeFile(
      path.join(project, "smali_classes2", "com", "other", "Loader.smali"),
      `.class public Lcom/other/Loader;
.super Ljava/lang/Object;

.method public constructor <init>()V
    .locals 0
    return-void
.end method
`,
    );
    const result = await run({
      projectDir: project,
      gadgetPath: gp,
      entryClass: "com.other.Loader",
    });
    expect(result.smaliFile).toBe("smali_classes2/com/other/Loader.smali");
    expect(result.insertMethod).toBe("<init>");
  });

  it("refuses a missing project, a non-project dir, a bad gadget and a bad ABI", async () => {
    const gp = await gadget();
    await expect(run({ gadgetPath: gp })).rejects.toThrow(/requires "projectDir"/);
    await expect(run({ projectDir: root, gadgetPath: gp })).rejects.toThrow(/apktool project/);
    await expect(
      run({ projectDir: project, gadgetPath: path.join(root, "nope.so") }),
    ).rejects.toThrow(/Gadget .so not found/);
    await expect(run({ projectDir: project, gadgetPath: gp, abi: "mips" })).rejects.toThrow(
      /abi.*must be one of/,
    );
  });

  it("refuses an entry class with no smali in the project", async () => {
    const gp = await gadget();
    await expect(
      run({ projectDir: project, gadgetPath: gp, entryClass: "com.ghost.Missing" }),
    ).rejects.toThrow(/No smali file for/);
  });

  it("refuses a manifest with no application class and no explicit entryClass", async () => {
    const gp = await gadget();
    await writeFile(
      path.join(project, "AndroidManifest.xml"),
      '<manifest package="com.acme"><application /></manifest>',
    );
    await expect(run({ projectDir: project, gadgetPath: gp })).rejects.toThrow(
      /declares no application class/,
    );
  });
});
