import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listFiles, parseJavaSources } from "../src/graph/java-indexer.js";

describe("parseJavaSources", () => {
  it("makes a class per file, a package per directory, and contains edges", () => {
    const { entities, edges, truncated } = parseJavaSources([
      "com/acme/Login.java",
      "com/acme/Api.java",
      "com/acme/net/Http.java",
    ]);

    expect(truncated).toBe(false);
    expect(entities.filter((e) => e.type === "class").map((e) => e.name)).toEqual([
      "com.acme.Login",
      "com.acme.Api",
      "com.acme.net.Http",
    ]);
    expect(entities.filter((e) => e.type === "package")).toEqual([
      { type: "package", name: "com.acme", attributes: { classCount: 2 } },
      { type: "package", name: "com.acme.net", attributes: { classCount: 1 } },
    ]);
    expect(edges).toContainEqual({
      from: { type: "package", name: "com.acme" },
      to: { type: "class", name: "com.acme.Login" },
      relation: "contains",
    });
    expect(edges).toHaveLength(3);
  });

  it("records each class's source file so a finding can cite it as a location", () => {
    const { entities } = parseJavaSources(["com/acme/Login.java"]);

    expect(entities[0]).toEqual({
      type: "class",
      name: "com.acme.Login",
      attributes: { file: "com/acme/Login.java" },
    });
  });

  it("gives a top-level class no package and no edge", () => {
    const { entities, edges } = parseJavaSources(["Main.java"]);

    expect(entities).toEqual([{ type: "class", name: "Main", attributes: { file: "Main.java" } }]);
    expect(edges).toEqual([]);
  });

  it("ignores non-java files, package-info and module-info", () => {
    const { entities } = parseJavaSources([
      "com/acme/package-info.java",
      "module-info.java",
      "com/acme/notes.txt",
      "com/acme/Real.java",
    ]);

    expect(entities.filter((e) => e.type === "class").map((e) => e.name)).toEqual([
      "com.acme.Real",
    ]);
  });

  it("indexes only the first classes when there are more than the cap, and says so", () => {
    const files = ["a/One.java", "a/Two.java", "a/Three.java"];
    const { entities, edges, truncated } = parseJavaSources(files, 2);

    expect(truncated).toBe(true);
    expect(entities.filter((e) => e.type === "class")).toHaveLength(2);
    expect(edges).toHaveLength(2);
  });
});

describe("listFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hexforge-java-indexer-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns sorted relative forward-slash paths of every file", async () => {
    await mkdir(path.join(dir, "com", "acme"), { recursive: true });
    await writeFile(path.join(dir, "Main.java"), "");
    await writeFile(path.join(dir, "com", "acme", "Login.java"), "");
    await writeFile(path.join(dir, "com", "Zed.java"), "");

    await expect(listFiles(dir)).resolves.toEqual([
      "Main.java",
      "com/Zed.java",
      "com/acme/Login.java",
    ]);
  });

  it("stops collecting at the limit", async () => {
    for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(dir, `${name}.java`), "");

    await expect(listFiles(dir, 2)).resolves.toHaveLength(2);
  });
});

// End to end: a recorded java-sources artifact on disk, indexed into real
// local storage next to the real artifact and graph services.
describe("indexJavaArtifact", () => {
  let dataDir: string;
  let outDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-indexer-data-"));
    outDir = await mkdtemp(path.join(tmpdir(), "hexforge-indexer-out-"));
    vi.resetModules();
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dataDir, { recursive: true, force: true });
    await rm(outDir, { recursive: true, force: true });
  });

  async function setup(layout: "sources" | "flat") {
    const base = layout === "sources" ? path.join(outDir, "sources") : outDir;
    await mkdir(path.join(base, "com", "acme"), { recursive: true });
    await writeFile(path.join(base, "com", "acme", "Login.java"), "class Login {}");
    await writeFile(path.join(base, "com", "acme", "Api.java"), "class Api {}");
    if (layout === "sources") {
      await mkdir(path.join(outDir, "resources"), { recursive: true });
      await writeFile(path.join(outDir, "resources", "Ignored.java"), "");
    }

    const artifacts = await import("../src/artifacts/artifact.service.js");
    const graph = await import("../src/graph/graph.service.js");
    const indexer = await import("../src/graph/java-indexer.js");
    const artifact = await artifacts.recordArtifact({
      workspaceId: "ws1",
      kind: "java-sources",
      path: outDir,
      pathType: "directory",
      source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
    });
    return { artifact, graph, indexer };
  }

  it("indexes jadx's sources/ directory into packages, classes and contains edges", async () => {
    const { artifact, graph, indexer } = await setup("sources");

    const result = await indexer.indexJavaArtifact(artifact);

    expect(result).toEqual({
      entities: { created: 3, updated: 0 },
      edges: { created: 2, existing: 0 },
    });
    const classes = await graph.listEntities("ws1", { type: "class" });
    expect(classes.map((c) => c.name)).toEqual(["com.acme.Api", "com.acme.Login"]);
    expect(classes[0]?.artifactIds).toEqual([artifact.id]);
    expect(classes.map((c) => c.name)).not.toContain("Ignored");
    const [pkg] = await graph.listEntities("ws1", { type: "package" });
    expect(pkg).toMatchObject({ name: "com.acme", attributes: { classCount: 2 } });
    expect((await graph.getEntityWithEdges(pkg!.id))?.edges).toHaveLength(2);
  });

  it("falls back to the artifact directory when there is no sources/ folder", async () => {
    const { artifact, graph, indexer } = await setup("flat");

    await indexer.indexJavaArtifact(artifact);

    const classes = await graph.listEntities("ws1", { type: "class" });
    expect(classes.map((c) => c.name)).toEqual(["com.acme.Api", "com.acme.Login"]);
  });

  it("is idempotent: indexing the same artifact again creates nothing new", async () => {
    const { artifact, graph, indexer } = await setup("sources");

    await indexer.indexJavaArtifact(artifact);
    const again = await indexer.indexJavaArtifact(artifact);

    expect(again).toEqual({
      entities: { created: 0, updated: 3 },
      edges: { created: 0, existing: 2 },
    });
    expect(await graph.listEntities("ws1")).toHaveLength(3);
    expect(await graph.listEdges("ws1")).toHaveLength(2);
  });
});
