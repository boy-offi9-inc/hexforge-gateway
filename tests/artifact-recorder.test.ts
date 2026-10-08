import { describe, expect, it } from "vitest";
import { extractArtifacts } from "../src/artifacts/recorder.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import type { McpTask } from "../src/core/types.js";

// extractArtifacts is pure (task + registry in, inputs out), so these tests
// use a fresh registry and need no storage, events or mocks.
const registry = new CapabilityRegistry();
registry.register({
  kind: "jadx",
  operations: [
    { name: "decompile", capability: "java.decompile", outputs: ["java-sources"] },
    { name: "noop", capability: "java.search" },
  ],
});
registry.register({
  kind: "apktool",
  operations: [
    { name: "build", capability: "android.rebuild", outputs: ["apk"] },
    { name: "both", capability: "android.decode", outputs: ["a", "b"] },
  ],
});

const task = (over: Partial<McpTask>): McpTask => ({
  id: "t1",
  workspaceId: "ws1",
  agent: "jadx",
  operation: "decompile",
  payload: {},
  status: "completed",
  createdAt: "",
  updatedAt: "",
  result: { outputDir: "/ws/ws1/jadx" },
  ...over,
});

describe("extractArtifacts", () => {
  it("records a directory from outputDir with the declared kind and source", () => {
    expect(extractArtifacts(task({}), registry)).toEqual([
      {
        workspaceId: "ws1",
        kind: "java-sources",
        path: "/ws/ws1/jadx",
        pathType: "directory",
        source: {
          taskId: "t1",
          agent: "jadx",
          operation: "decompile",
          capability: "java.decompile",
        },
      },
    ]);
  });

  it("records a file from outputPath", () => {
    const [artifact] = extractArtifacts(
      task({ agent: "apktool", operation: "build", result: { outputPath: "/ws/out.apk" } }),
      registry,
    );
    expect(artifact).toMatchObject({ kind: "apk", path: "/ws/out.apk", pathType: "file" });
  });

  it("records nothing for failed tasks", () => {
    expect(extractArtifacts(task({ status: "failed" }), registry)).toEqual([]);
  });

  it("records nothing for unknown agents or operations that declare no outputs", () => {
    expect(extractArtifacts(task({ agent: "frida" }), registry)).toEqual([]);
    expect(extractArtifacts(task({ operation: "noop" }), registry)).toEqual([]);
  });

  it("records nothing when an operation declares more than one output kind", () => {
    const multi = task({ agent: "apktool", operation: "both" });
    expect(extractArtifacts(multi, registry)).toEqual([]);
  });

  it("records nothing when the result has no usable path", () => {
    expect(extractArtifacts(task({ result: undefined }), registry)).toEqual([]);
    expect(extractArtifacts(task({ result: "done" }), registry)).toEqual([]);
    expect(extractArtifacts(task({ result: { outputDir: "" } }), registry)).toEqual([]);
    expect(extractArtifacts(task({ result: { files: [] } }), registry)).toEqual([]);
  });
});
