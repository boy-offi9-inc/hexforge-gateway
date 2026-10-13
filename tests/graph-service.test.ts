import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Real local storage in a throwaway DATA_DIR with a fresh module graph per
// test, next to the real artifact service so cited artifacts are checked
// against ones that were actually recorded (same approach as
// finding-service.test.ts).
type GraphService = typeof import("../src/graph/graph.service.js");
type ArtifactService = typeof import("../src/artifacts/artifact.service.js");

let dataDir: string;
let graph: GraphService;
let artifacts: ArtifactService;

const record = (workspaceId: string) =>
  artifacts.recordArtifact({
    workspaceId,
    kind: "java-sources",
    path: `/ws/${workspaceId}/jadx`,
    pathType: "directory",
    source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
  });

const entity = (name: string, type: "class" | "package" = "class", workspaceId = "ws1") =>
  graph.upsertEntity({ workspaceId, type, name }).then((r) => r.entity);

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-graph-"));
  vi.resetModules();
  vi.stubEnv("DATA_DIR", dataDir);
  graph = await import("../src/graph/graph.service.js");
  artifacts = await import("../src/artifacts/artifact.service.js");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe("graph entities", () => {
  it("creates an entity, then merges into it when the same type and name come again", async () => {
    const a1 = await record("ws1");
    const first = await graph.upsertEntity({
      workspaceId: "ws1",
      type: "class",
      name: "com.acme.Login",
      attributes: { obfuscated: false, lines: 120 },
      artifactIds: [a1.id],
    });
    expect(first.created).toBe(true);
    expect(first.entity.attributes).toEqual({ obfuscated: false, lines: 120 });

    const second = await graph.upsertEntity({
      workspaceId: "ws1",
      type: "class",
      name: "com.acme.Login",
      attributes: { lines: 130, kind: "activity" },
    });
    expect(second.created).toBe(false);
    expect(second.entity.id).toBe(first.entity.id);
    expect(second.entity.createdAt).toBe(first.entity.createdAt);
    expect(second.entity.attributes).toEqual({ obfuscated: false, lines: 130, kind: "activity" });
    expect(second.entity.artifactIds).toEqual([a1.id]);
    expect(await graph.listEntities("ws1")).toHaveLength(1);
  });

  it("unions artifact ids across upserts", async () => {
    const a1 = await record("ws1");
    const a2 = await artifacts.recordArtifact({
      workspaceId: "ws1",
      kind: "apk",
      path: "/ws/ws1/out.apk",
      pathType: "file",
      source: { taskId: "t2", agent: "apktool", operation: "build", capability: "android.rebuild" },
    });
    await graph.upsertEntity({
      workspaceId: "ws1",
      type: "url",
      name: "http://a",
      artifactIds: [a1.id],
    });
    const { entity: merged } = await graph.upsertEntity({
      workspaceId: "ws1",
      type: "url",
      name: "http://a",
      artifactIds: [a2.id, a1.id],
    });

    expect(merged.artifactIds.sort()).toEqual([a1.id, a2.id].sort());
  });

  it("keeps type and workspace apart: same name is a different entity", async () => {
    const asClass = await entity("com.acme", "class");
    const asPackage = await entity("com.acme", "package");
    const otherWorkspace = await entity("com.acme", "class", "ws2");

    expect(new Set([asClass.id, asPackage.id, otherWorkspace.id]).size).toBe(3);
  });

  it("rejects an unknown artifact or one from another workspace, saving nothing", async () => {
    const other = await record("ws2");

    await expect(
      graph.upsertEntity({ workspaceId: "ws1", type: "class", name: "A", artifactIds: ["nope"] }),
    ).rejects.toThrow(graph.GraphError);
    await expect(
      graph.upsertEntity({ workspaceId: "ws1", type: "class", name: "A", artifactIds: [other.id] }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(graph.listEntities("ws1")).resolves.toEqual([]);
  });

  it("lists by workspace sorted by name, filtered by type and a name substring", async () => {
    await entity("com.acme.Zeta");
    await entity("com.acme.Alpha");
    await entity("com.acme", "package");
    await entity("org.other.Thing");
    await entity("com.acme.Elsewhere", "class", "ws2");

    const all = await graph.listEntities("ws1");
    expect(all.map((e) => e.name)).toEqual([
      "com.acme",
      "com.acme.Alpha",
      "com.acme.Zeta",
      "org.other.Thing",
    ]);
    expect((await graph.listEntities("ws1", { type: "package" })).map((e) => e.name)).toEqual([
      "com.acme",
    ]);
    expect((await graph.listEntities("ws1", { q: "ACME.a" })).map((e) => e.name)).toEqual([
      "com.acme.Alpha",
    ]);
  });
});

describe("graph edges", () => {
  it("adds an edge between two entities and is a no-op the second time", async () => {
    const pkg = await entity("com.acme", "package");
    const cls = await entity("com.acme.Login");

    const first = await graph.addEdge({
      workspaceId: "ws1",
      from: pkg.id,
      to: cls.id,
      relation: "contains",
    });
    const again = await graph.addEdge({
      workspaceId: "ws1",
      from: pkg.id,
      to: cls.id,
      relation: "contains",
    });

    expect(first.created).toBe(true);
    expect(again).toEqual({ edge: first.edge, created: false });
    expect(await graph.listEdges("ws1")).toHaveLength(1);
  });

  it("rejects self edges and ends that are missing or in another workspace", async () => {
    const a = await entity("A");
    const foreign = await entity("B", "class", "ws2");

    await expect(
      graph.addEdge({ workspaceId: "ws1", from: a.id, to: a.id, relation: "calls" }),
    ).rejects.toThrow(/itself/);
    await expect(
      graph.addEdge({ workspaceId: "ws1", from: a.id, to: "ghost", relation: "calls" }),
    ).rejects.toThrow(graph.GraphError);
    await expect(
      graph.addEdge({ workspaceId: "ws1", from: a.id, to: foreign.id, relation: "calls" }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(graph.listEdges("ws1")).resolves.toEqual([]);
  });

  it("treats direction and relation as part of an edge's identity", async () => {
    const a = await entity("A");
    const b = await entity("B");
    const link = (from: string, to: string, relation: "calls" | "accesses") =>
      graph.addEdge({ workspaceId: "ws1", from, to, relation });

    const ids = new Set([
      (await link(a.id, b.id, "calls")).edge.id,
      (await link(b.id, a.id, "calls")).edge.id,
      (await link(a.id, b.id, "accesses")).edge.id,
    ]);
    expect(ids.size).toBe(3);
  });

  it("lists edges by entity (either end) and relation, and returns entity + edges", async () => {
    const a = await entity("A");
    const b = await entity("B");
    const c = await entity("C");
    const base = { workspaceId: "ws1" };
    await graph.addEdge({ ...base, from: a.id, to: b.id, relation: "calls" });
    await graph.addEdge({ ...base, from: c.id, to: a.id, relation: "accesses" });
    await graph.addEdge({ ...base, from: b.id, to: c.id, relation: "calls" });

    expect(await graph.listEdges("ws1", { entityId: a.id })).toHaveLength(2);
    expect(await graph.listEdges("ws1", { entityId: a.id, relation: "calls" })).toHaveLength(1);
    expect(await graph.listEdges("ws1", { relation: "calls" })).toHaveLength(2);

    const withEdges = await graph.getEntityWithEdges(a.id);
    expect(withEdges?.entity.id).toBe(a.id);
    expect(withEdges?.edges).toHaveLength(2);
    await expect(graph.getEntityWithEdges("nope")).resolves.toBeNull();
  });
});

describe("graph indexBatch", () => {
  const cls = (name: string, attributes = {}) => ({ type: "class" as const, name, attributes });
  const ref = (name: string, type: "class" | "package" = "class") => ({ type, name });

  it("adds entities and edges in one call and reports what was created", async () => {
    const a = await record("ws1");
    const result = await graph.indexBatch({
      workspaceId: "ws1",
      artifactId: a.id,
      entities: [{ type: "package", name: "com.acme" }, cls("com.acme.Login"), cls("com.acme.Api")],
      edges: [
        { from: ref("com.acme", "package"), to: ref("com.acme.Login"), relation: "contains" },
        { from: ref("com.acme", "package"), to: ref("com.acme.Api"), relation: "contains" },
      ],
    });

    expect(result).toEqual({
      entities: { created: 3, updated: 0 },
      edges: { created: 2, existing: 0 },
    });
    expect(await graph.listEntities("ws1")).toHaveLength(3);
    expect(await graph.listEdges("ws1")).toHaveLength(2);
    const [login] = await graph.listEntities("ws1", { q: "login" });
    expect(login?.artifactIds).toEqual([a.id]);
  });

  it("merges into entities and edges that already exist", async () => {
    const a = await record("ws1");
    const existing = await entity("com.acme.Login");
    const b = await artifacts.recordArtifact({
      workspaceId: "ws1",
      kind: "apk",
      path: "/ws/ws1/out.apk",
      pathType: "file",
      source: { taskId: "t2", agent: "apktool", operation: "build", capability: "android.rebuild" },
    });
    await graph.indexBatch({
      workspaceId: "ws1",
      artifactId: a.id,
      entities: [cls("com.acme.Login", { lines: 1 }), cls("com.acme.Api")],
      edges: [{ from: ref("com.acme.Login"), to: ref("com.acme.Api"), relation: "calls" }],
    });

    const again = await graph.indexBatch({
      workspaceId: "ws1",
      artifactId: b.id,
      entities: [cls("com.acme.Login", { lines: 2 }), cls("com.acme.Api")],
      edges: [{ from: ref("com.acme.Login"), to: ref("com.acme.Api"), relation: "calls" }],
    });

    expect(again).toEqual({
      entities: { created: 0, updated: 2 },
      edges: { created: 0, existing: 1 },
    });
    const merged = await graph.getEntity(existing.id);
    expect(merged?.attributes).toEqual({ lines: 2 });
    expect(merged?.artifactIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("collapses repeats within one batch into a single entity", async () => {
    const a = await record("ws1");
    await graph.indexBatch({
      workspaceId: "ws1",
      artifactId: a.id,
      entities: [cls("A", { x: 1 }), cls("A", { y: 2 })],
      edges: [],
    });

    const [only] = await graph.listEntities("ws1");
    expect(only?.attributes).toEqual({ x: 1, y: 2 });
    expect(await graph.listEntities("ws1")).toHaveLength(1);
  });

  it("rejects bad batches without writing anything", async () => {
    const a = await record("ws1");
    const other = await record("ws2");
    const base = { workspaceId: "ws1", artifactId: a.id };

    await expect(
      graph.indexBatch({ ...base, artifactId: other.id, entities: [cls("A")], edges: [] }),
    ).rejects.toThrow(/Artifact not found/);
    await expect(
      graph.indexBatch({
        ...base,
        entities: [cls("A")],
        edges: [{ from: ref("A"), to: ref("Missing"), relation: "calls" }],
      }),
    ).rejects.toThrow(/isn't in the batch/);
    await expect(
      graph.indexBatch({
        ...base,
        entities: [cls("A")],
        edges: [{ from: ref("A"), to: ref("A"), relation: "calls" }],
      }),
    ).rejects.toThrow(/itself/);
    expect(await graph.listEntities("ws1")).toEqual([]);
    expect(await graph.listEdges("ws1")).toEqual([]);
  });
});
