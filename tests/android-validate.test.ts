import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkXmlWellFormed, validateProject } from "../src/modules/mcp/agents/android-validate.js";

describe("checkXmlWellFormed", () => {
  it("accepts well-formed XML with declarations, comments and CDATA", () => {
    expect(
      checkXmlWellFormed(
        `<?xml version="1.0" encoding="utf-8"?><!-- c --><manifest><application android:label="App" /><uses-permission android:name="x" /></manifest>`,
      ),
    ).toBeNull();
    expect(checkXmlWellFormed(`<a><![CDATA[ <not a tag> ]]></a>`)).toBeNull();
    expect(checkXmlWellFormed(`<a><b>text with "quotes" inside</b></a>`)).toBeNull();
  });

  it("catches an unclosed tag", () => {
    expect(checkXmlWellFormed(`<manifest><application>`)).toMatchObject({
      problem: expect.stringContaining("unclosed <application>"),
    });
  });

  it("catches mismatched nesting", () => {
    expect(checkXmlWellFormed(`<a><b></a></b>`)).toMatchObject({
      problem: expect.stringContaining("doesn't match"),
    });
  });

  it("catches an unbalanced quote inside a tag", () => {
    expect(checkXmlWellFormed(`<a href="broken></a>`)).toMatchObject({
      problem: expect.stringContaining("unbalanced quote"),
    });
  });
});

describe("validateProject", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hexforge-validate-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function seedProject(opts: {
    manifest?: string;
    res?: Record<string, string>;
    smali?: Record<string, string>;
    yml?: string;
  }) {
    await mkdir(path.join(dir, "res", "values"), { recursive: true });
    await mkdir(path.join(dir, "smali", "com", "acme"), { recursive: true });
    await writeFile(path.join(dir, "apktool.yml"), opts.yml ?? "apkFileName: app.apk\n");
    await writeFile(
      path.join(dir, "AndroidManifest.xml"),
      opts.manifest ?? `<manifest><application /></manifest>`,
    );
    for (const [rel, content] of Object.entries(opts.res ?? {})) {
      await mkdir(path.dirname(path.join(dir, "res", rel)), { recursive: true });
      await writeFile(path.join(dir, "res", rel), content);
    }
    for (const [rel, content] of Object.entries(opts.smali ?? {})) {
      await writeFile(path.join(dir, "smali", rel), content);
    }
  }

  it("passes a healthy project", async () => {
    await seedProject({
      res: { "values/strings.xml": `<resources><string name="a">hi</string></resources>` },
      smali: { "com/acme/A.smali": ".class public Lcom/acme/A;" },
    });
    const result = await validateProject(dir);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.checked).toEqual({ manifest: true, xmlFiles: 1, smaliFiles: 1 });
  });

  it("reports a broken manifest from a bad patch", async () => {
    await seedProject({ manifest: `<manifest><application></manifest>` });
    const result = await validateProject(dir);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      file: "AndroidManifest.xml",
      problem: expect.stringContaining("nesting is broken"),
    });
  });

  it("reports broken resource XML and empty smali files together (all issues at once)", async () => {
    await seedProject({
      res: { "values/strings.xml": `<resources><string</resources>` },
      smali: { "com/acme/Truncated.smali": "" },
    });
    const result = await validateProject(dir);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    const files = result.issues.map((i) => i.file).sort();
    expect(files).toEqual(["res/values/strings.xml", "smali/com/acme/Truncated.smali"]);
  });

  it("flags a missing referenced APK in apktool.yml", async () => {
    await seedProject({ yml: "apkFileName: app.apk\nsplit: base.apk\n  - missing-split.apk\n" });
    const result = await validateProject(dir);
    expect(result.issues.some((i) => i.problem.includes("missing-split.apk"))).toBe(true);
  });

  it("reports a missing manifest and missing apktool.yml for a non-project directory", async () => {
    const empty = path.join(dir, "empty");
    await mkdir(empty);
    const result = await validateProject(empty);
    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.checked.manifest).toBe(false);
  });
});
