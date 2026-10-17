import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseSmaliSources } from "../src/graph/smali-indexer.js";

describe("parseSmaliSources", () => {
  const names = (entities: { type: string; name: string }[], type: string) =>
    entities.filter((e) => e.type === type).map((e) => e.name);

  it("makes a class per smali file, a package per directory, and contains edges", () => {
    const { entities, edges, truncated } = parseSmaliSources([
      "smali/com/acme/Login.smali",
      "smali/com/acme/Api.smali",
      "smali/com/acme/net/Http.smali",
    ]);

    expect(truncated).toBe(false);
    expect(names(entities, "class")).toEqual([
      "com.acme.Login",
      "com.acme.Api",
      "com.acme.net.Http",
    ]);
    expect(entities.filter((e) => e.type === "package")).toEqual([
      { type: "package", name: "com.acme", attributes: { smaliClassCount: 2 } },
      { type: "package", name: "com.acme.net", attributes: { smaliClassCount: 1 } },
    ]);
    expect(edges).toContainEqual({
      from: { type: "package", name: "com.acme" },
      to: { type: "class", name: "com.acme.Login" },
      relation: "contains",
    });
    expect(edges).toHaveLength(3);
  });

  it("records the smali path relative to the artifact, so a finding can cite it", () => {
    const { entities } = parseSmaliSources(["smali_classes2/com/acme/Login.smali"]);

    expect(entities[0]).toEqual({
      type: "class",
      name: "com.acme.Login",
      attributes: { smaliFile: "smali_classes2/com/acme/Login.smali" },
    });
  });

  it("uses its own attribute names, so Java's file and classCount are never overwritten", () => {
    const { entities } = parseSmaliSources(["smali/com/acme/Login.smali"]);

    for (const e of entities) {
      expect(Object.keys(e.attributes ?? {})).not.toContain("file");
      expect(Object.keys(e.attributes ?? {})).not.toContain("classCount");
    }
  });

  it("reads every smali directory (smali, smali_classes2, ...) and ignores other folders", () => {
    const { entities } = parseSmaliSources([
      "smali/com/a/One.smali",
      "smali_classes2/com/a/Two.smali",
      "smali_classes10/com/b/Three.smali",
      "res/layout/Main.smali",
      "assets/com/a/Four.smali",
      "smali/com/a/readme.txt",
    ]);

    expect(names(entities, "class")).toEqual(["com.a.One", "com.a.Two", "com.b.Three"]);
  });

  it("keeps the first copy of a class that appears in two dex directories", () => {
    const { entities } = parseSmaliSources([
      "smali/com/a/Dup.smali",
      "smali_classes2/com/a/Dup.smali",
    ]);

    const dup = entities.filter((e) => e.name === "com.a.Dup");
    expect(dup).toHaveLength(1);
    expect(dup[0]?.attributes).toEqual({ smaliFile: "smali/com/a/Dup.smali" });
  });

  it("gives a top-level class no package and no edge", () => {
    const { entities, edges } = parseSmaliSources(["smali/Main.smali"]);

    expect(names(entities, "class")).toEqual(["Main"]);
    expect(names(entities, "package")).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("links an inner class to its outer class, but only when the outer class is present", () => {
    const { edges } = parseSmaliSources([
      "smali/com/a/Outer.smali",
      "smali/com/a/Outer$Inner.smali",
      "smali/com/a/Outer$1.smali",
      "smali/com/a/Lonely$Part.smali",
    ]);

    const inner = edges.filter((e) => e.from.type === "class");
    expect(inner.map((e) => e.to.name).sort()).toEqual(["com.a.Outer$1", "com.a.Outer$Inner"]);
    expect(inner.every((e) => e.from.name === "com.a.Outer")).toBe(true);
  });

  it("indexes only the first classes when there are more than the cap, and says so", () => {
    const files = ["smali/a/One.smali", "smali/a/Two.smali", "smali/a/Three.smali"];
    const { entities, edges, truncated } = parseSmaliSources(files, 2);

    expect(truncated).toBe(true);
    expect(names(entities, "class")).toEqual(["a.One", "a.Two"]);
    expect(edges).toHaveLength(2);
  });
});

// End to end on a real temp directory, with real local storage next to the
// real artifact, graph and Java-indexer modules.
describe("indexSmaliArtifact", () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-smali-data-"));
    outDir = await mkdtemp(path.join(tmpdir(), "hexforge-smali-out-"));
    vi.resetModules();
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function write(rel: string) {
    await mkdir(path.dirname(path.join(outDir, rel)), { recursive: true });
    await writeFile(path.join(outDir, rel), ".class public Lx;");
  }

  async function modules() {
    return {
      artifacts: await import("../src/artifacts/artifact.service.js"),
      graph: await import("../src/graph/graph.service.js"),
      smali: await import("../src/graph/smali-indexer.js"),
      java: await import("../src/graph/java-indexer.js"),
    };
  }

  const record = (
    m: Awaited<ReturnType<typeof modules>>,
    kind: string,
    dir: string,
    operation: string,
  ) =>
    m.artifacts.recordArtifact({
      workspaceId: "ws1",
      kind,
      path: dir,
      pathType: "directory",
      source: { taskId: "t", agent: "x", operation, capability: "x.y" },
    });

  it("indexes every smali directory, ignoring res/ and the manifest", async () => {
    await write("smali/com/acme/Login.smali");
    await write("smali_classes2/com/acme/Api.smali");
    await write("res/values/strings.xml");
    await write("AndroidManifest.xml");
    const m = await modules();
    const artifact = await record(m, "apktool-project", outDir, "decode");

    const result = await m.smali.indexSmaliArtifact(artifact);

    expect(result).toEqual({
      entities: { created: 3, updated: 0 },
      edges: { created: 2, existing: 0 },
    });
    const classes = await m.graph.listEntities("ws1", { type: "class" });
    expect(classes.map((c) => c.name)).toEqual(["com.acme.Api", "com.acme.Login"]);
    expect(classes[0]?.attributes).toEqual({ smaliFile: "smali_classes2/com/acme/Api.smali" });
    expect(classes[0]?.artifactIds).toEqual([artifact.id]);
  });

  it("returns null and writes nothing when there is no smali (a noSrc decode)", async () => {
    await write("res/values/strings.xml");
    await write("AndroidManifest.xml");
    const m = await modules();
    const artifact = await record(m, "apktool-project", outDir, "decode");

    await expect(m.smali.indexSmaliArtifact(artifact)).resolves.toBeNull();
    expect(await m.graph.listEntities("ws1")).toEqual([]);
  });

  it("is idempotent: indexing the same decode again creates nothing new", async () => {
    await write("smali/com/acme/Login.smali");
    const m = await modules();
    const artifact = await record(m, "apktool-project", outDir, "decode");

    await m.smali.indexSmaliArtifact(artifact);
    const again = await m.smali.indexSmaliArtifact(artifact);

    expect(again).toEqual({
      entities: { created: 0, updated: 2 },
      edges: { created: 0, existing: 1 },
    });
    expect(await m.graph.listEntities("ws1")).toHaveLength(2);
  });

  it("enriches the entity jadx already created instead of duplicating it", async () => {
    const javaOut = await mkdtemp(path.join(tmpdir(), "hexforge-smali-java-"));
    try {
      await mkdir(path.join(javaOut, "sources", "com", "acme"), { recursive: true });
      await writeFile(path.join(javaOut, "sources", "com", "acme", "Login.java"), "class Login {}");
      await write("smali/com/acme/Login.smali");
      const m = await modules();
      const javaArtifact = await record(m, "java-sources", javaOut, "decompile");
      const smaliArtifact = await record(m, "apktool-project", outDir, "decode");

      await m.java.indexJavaArtifact(javaArtifact);
      await m.smali.indexSmaliArtifact(smaliArtifact);

      const classes = await m.graph.listEntities("ws1", { type: "class" });
      expect(classes).toHaveLength(1);
      expect(classes[0]?.attributes).toEqual({
        file: "com/acme/Login.java",
        smaliFile: "smali/com/acme/Login.smali",
      });
      expect(classes[0]?.artifactIds.sort()).toEqual([javaArtifact.id, smaliArtifact.id].sort());
      const [pkg] = await m.graph.listEntities("ws1", { type: "package" });
      expect(pkg?.attributes).toEqual({ classCount: 1, smaliClassCount: 1 });
      expect(await m.graph.listEdges("ws1")).toHaveLength(1);
    } finally {
      await rm(javaOut, { recursive: true, force: true });
    }
  });
});
