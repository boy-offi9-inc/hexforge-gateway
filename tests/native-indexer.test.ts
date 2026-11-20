import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jniEdges,
  jniSymbolToJavaPrefixes,
  parseNativeFunctions,
} from "../src/graph/native-indexer.js";

vi.mock("../src/events/event-bus.js", () => ({
  eventBus: { on: vi.fn(), emit: vi.fn() },
}));

const WORKSPACES_ROOT = path.join(os.tmpdir(), "hexforge-native-indexer-test-workspaces");

function workspaceId(): string {
  return "ws-native-" + Math.random().toString(36).slice(2);
}

function reportFile(dir: string, report: unknown): string {
  const file = path.join(dir, `lib-${Math.random().toString(36).slice(2)}.analysis.json`);
  writeFileSync(file, JSON.stringify(report));
  return file;
}

describe("jniSymbolToJavaPrefixes", () => {
  it("maps Java_pkg_Class_method to pkg.Class.method", () => {
    expect(jniSymbolToJavaPrefixes("Java_com_acme_Foo_bar")).toEqual(["com.acme.Foo.bar"]);
  });

  it("drops the overload suffix after __", () => {
    expect(jniSymbolToJavaPrefixes("Java_com_acme_Foo_bar__I")).toEqual(["com.acme.Foo.bar"]);
  });

  it("unescapes JNI component encoding", () => {
    // Java_com_bug_1tracker_Foo_1Deep_bar: bug_tracker.Foo_Deep.bar
    expect(jniSymbolToJavaPrefixes("Java_com_bug_1tracker_Foo_1Deep_bar")).toEqual([
      "com.bug_tracker.Foo_Deep.bar",
    ]);
  });

  it("returns nothing for non-JNI symbols", () => {
    expect(jniSymbolToJavaPrefixes("main")).toEqual([]);
    expect(jniSymbolToJavaPrefixes("Java_ShortWithoutMethod")).toEqual([]);
    expect(jniSymbolToJavaPrefixes("_ZSt4cout")).toEqual([]);
  });
});

describe("parseNativeFunctions", () => {
  it("creates one entity per unique function with address and size attributes", () => {
    const { entities, truncated } = parseNativeFunctions({
      program: "libtest.so",
      functions: [
        { name: "Java_com_acme_Foo_bar", address: "00010000", size: 42 },
        { name: "Java_com_acme_Foo_bar", address: "00010000" }, // duplicate: skipped
        { name: "native_helper", address: "00010100", size: 8 },
        { name: "" }, // unnamed: skipped
      ],
    });
    expect(entities).toEqual([
      {
        type: "native-function",
        name: "Java_com_acme_Foo_bar",
        attributes: { address: "00010000", size: 42 },
      },
      {
        type: "native-function",
        name: "native_helper",
        attributes: { address: "00010100", size: 8 },
      },
    ]);
    expect(truncated).toBe(false);
  });

  it("flags truncation and honors the cap", () => {
    const functions = Array.from({ length: 50 }, (_, i) => ({ name: `fn_${i}` }));
    const { entities, truncated } = parseNativeFunctions({ functions }, 10);
    expect(entities).toHaveLength(10);
    expect(entities[9].name).toBe("fn_9");
    expect(truncated).toBe(true);
  });
});

describe("jniEdges", () => {
  it("links a JNI symbol to the native method entity with the same parameter-less prefix", () => {
    const edges = jniEdges(
      ["Java_com_acme_Foo_bar"],
      [{ name: "com.acme.Foo.bar(int,String)" }, { name: "com.acme.Other.baz()" }],
    );
    expect(edges).toEqual([
      {
        from: { type: "native-function", name: "Java_com_acme_Foo_bar" },
        to: { type: "method", name: "com.acme.Foo.bar(int,String)" },
        relation: "maps-to",
      },
    ]);
  });

  it("links every overload of the same method (one exported symbol)", () => {
    const edges = jniEdges(
      ["Java_com_acme_Foo_bar"],
      [{ name: "com.acme.Foo.bar()" }, { name: "com.acme.Foo.bar(int)" }],
    );
    expect(edges).toHaveLength(2);
    expect(edges.map((e) => e.to.name).sort()).toEqual([
      "com.acme.Foo.bar()",
      "com.acme.Foo.bar(int)",
    ]);
  });

  it("matches the exact unparenthesized name too", () => {
    const edges = jniEdges(["Java_com_acme_Foo_bar"], [{ name: "com.acme.Foo.bar" }]);
    expect(edges).toHaveLength(1);
  });

  it("never fabricates a method entity: no matching native method, no edge", () => {
    expect(jniEdges(["Java_com_acme_Foo_bar"], [])).toEqual([]);
    // a non-native method with the same name does not qualify
    expect(jniEdges(["Java_com_acme_Foo_bar"], [{ name: "not-native" }])).toEqual([]);
  });

  it("ignores non-JNI symbols", () => {
    expect(jniEdges(["memcpy", "_ZSt4cout"], [{ name: "com.acme.Foo.bar()" }])).toEqual([]);
  });
});

describe("indexNativeArtifact", () => {
  let dir: string;
  let dataDir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hexforge-native-"));
    dataDir = mkdtempSync(path.join(os.tmpdir(), "hexforge-native-data-"));
    vi.resetModules();
    vi.stubEnv("DATA_DIR", dataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("indexes functions and JNI edges against the workspace's native methods", async () => {
    const ws = workspaceId();
    // seed the workspace with a native Java method (what the calls indexer writes)
    await import("../src/graph/graph.service.js").then((graph) =>
      graph.upsertEntity({
        workspaceId: ws,
        type: "method",
        name: "com.acme.Foo.bar(int)",
        attributes: { native: true },
      }),
    );
    const artifacts = await import("../src/artifacts/artifact.service.js");
    const artifact = await artifacts.recordArtifact({
      workspaceId: ws,
      kind: "native-analysis",
      path: reportFile(dir, {
        program: "libtest.so",
        functions: [
          { name: "Java_com_acme_Foo_bar", address: "00010000" },
          { name: "thread_start", address: "00020000" },
        ],
      }),
      pathType: "file",
      tools: [{ name: "ghidra" }],
      createdBy: "ghidra",
    });

    const native = await import("../src/graph/native-indexer.js");
    const result = await native.indexNativeArtifact(artifact);
    expect(result).not.toBeNull();
    expect(result!.entities.created).toBe(2); // both functions become entities
    expect(result!.edges.created).toBe(1); // the JNI symbol maps to the native method

    const graph = await import("../src/graph/graph.service.js");
    const fns = await graph.listEntities(ws, { type: "native-function" });
    expect(fns.map((e) => e.name).sort()).toEqual(["Java_com_acme_Foo_bar", "thread_start"]);
    const edges = await graph.listEdges(ws, { relation: "maps-to" });
    expect(edges).toHaveLength(1);
    const from = await graph.getEntity(edges[0].from);
    const to = await graph.getEntity(edges[0].to);
    expect(from?.name).toBe("Java_com_acme_Foo_bar");
    expect(to?.name).toBe("com.acme.Foo.bar(int)");
    // the native function was observed in the analysis artifact; the Java
    // method keeps only the artifacts that actually decompiled it - the edge
    // links them without claiming the decompile saw the binary
    expect(from?.artifactIds).toContain(artifact.id);
    expect(to?.artifactIds).not.toContain(artifact.id);
  });

  it("returns null for a report with no functions", async () => {
    const artifacts = await import("../src/artifacts/artifact.service.js");
    const artifact = await artifacts.recordArtifact({
      workspaceId: workspaceId(),
      kind: "native-analysis",
      path: reportFile(dir, { program: "empty.so", functions: [] }),
      pathType: "file",
      tools: [{ name: "ghidra" }],
      createdBy: "ghidra",
    });
    const native = await import("../src/graph/native-indexer.js");
    await expect(native.indexNativeArtifact(artifact)).resolves.toBeNull();
  });
});
