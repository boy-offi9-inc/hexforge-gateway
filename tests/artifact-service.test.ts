import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ArtifactInput } from "../src/artifacts/types.js";

// Real local storage in a throwaway DATA_DIR, with a fresh module graph per
// test (the provider caches collections per module instance) - the same
// approach as local-storage.provider.test.ts.
type ArtifactService = typeof import("../src/artifacts/artifact.service.js");

let dataDir: string;
let service: ArtifactService;

const input = (over: Partial<ArtifactInput> = {}): ArtifactInput => ({
  workspaceId: "ws1",
  kind: "java-sources",
  path: "/ws/ws1/jadx",
  pathType: "directory",
  source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
  ...over,
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-artifacts-"));
  vi.resetModules();
  vi.stubEnv("DATA_DIR", dataDir);
  service = await import("../src/artifacts/artifact.service.js");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe("artifact.service", () => {
  it("records, fetches and lists artifacts per workspace", async () => {
    const a = await service.recordArtifact(input());
    await service.recordArtifact(input({ workspaceId: "ws2" }));

    await expect(service.getArtifact(a.id)).resolves.toEqual(a);
    const listed = await service.listArtifactsForWorkspace("ws1");
    expect(listed.map((x) => x.id)).toEqual([a.id]);
  });

  it("filters the list by kind", async () => {
    await service.recordArtifact(input());
    await service.recordArtifact(input({ kind: "apk", path: "/ws/out.apk", pathType: "file" }));

    const apks = await service.listArtifactsForWorkspace("ws1", "apk");
    expect(apks.map((x) => x.kind)).toEqual(["apk"]);
  });

  it("updates in place when the same kind is produced at the same path again", async () => {
    const first = await service.recordArtifact(input());
    const second = await service.recordArtifact(
      input({
        source: {
          taskId: "t2",
          agent: "jadx",
          operation: "decompile",
          capability: "java.decompile",
        },
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.source.taskId).toBe("t2");
    expect(await service.listArtifactsForWorkspace("ws1")).toHaveLength(1);
  });

  it("returns null for an unknown id", async () => {
    await expect(service.getArtifact("nope")).resolves.toBeNull();
  });
});
