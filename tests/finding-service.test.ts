import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Real local storage in a throwaway DATA_DIR with a fresh module graph per
// test, and the real artifact service next to it, so evidence is checked
// against artifacts that were genuinely recorded (same approach as
// artifact-service.test.ts).
type FindingService = typeof import("../src/findings/finding.service.js");
type ArtifactService = typeof import("../src/artifacts/artifact.service.js");

let dataDir: string;
let findings: FindingService;
let artifacts: ArtifactService;

const record = (workspaceId: string) =>
  artifacts.recordArtifact({
    workspaceId,
    kind: "java-sources",
    path: `/ws/${workspaceId}/jadx`,
    pathType: "directory",
    source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
  });

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-findings-"));
  vi.resetModules();
  vi.stubEnv("DATA_DIR", dataDir);
  findings = await import("../src/findings/finding.service.js");
  artifacts = await import("../src/artifacts/artifact.service.js");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe("finding.service", () => {
  it("creates an unverified finding with no evidence by default", async () => {
    const f = await findings.createFinding({ workspaceId: "ws1", claim: "Uses cleartext HTTP" });

    expect(f).toMatchObject({ status: "unverified", evidence: [], source: "user" });
    await expect(findings.getFinding(f.id)).resolves.toEqual(f);
  });

  it("accepts evidence that cites real artifacts in the same workspace", async () => {
    const a = await record("ws1");
    const f = await findings.createFinding({
      workspaceId: "ws1",
      claim: "Hardcoded API key",
      status: "confirmed",
      confidence: "high",
      source: "ai",
      evidence: [{ artifactId: a.id, location: "com/acme/Api.java:12" }],
    });

    expect(f.status).toBe("confirmed");
    expect(f.evidence).toEqual([{ artifactId: a.id, location: "com/acme/Api.java:12" }]);
  });

  it("rejects evidence citing an unknown artifact, or one from another workspace", async () => {
    const other = await record("ws2");

    await expect(
      findings.createFinding({
        workspaceId: "ws1",
        claim: "x",
        evidence: [{ artifactId: "made-up" }],
      }),
    ).rejects.toThrow(findings.EvidenceError);

    await expect(
      findings.createFinding({
        workspaceId: "ws1",
        claim: "x",
        evidence: [{ artifactId: other.id }],
      }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(findings.listFindingsForWorkspace("ws1")).resolves.toEqual([]);
  });

  it("will not confirm a finding that has no evidence", async () => {
    await expect(
      findings.createFinding({ workspaceId: "ws1", claim: "x", status: "confirmed" }),
    ).rejects.toThrow(/at least one piece of evidence/);

    const f = await findings.createFinding({ workspaceId: "ws1", claim: "x" });
    await expect(findings.updateFinding(f.id, { status: "confirmed" })).rejects.toThrow(
      findings.EvidenceError,
    );
  });

  it("confirms once evidence is attached, and re-checks replaced evidence", async () => {
    const a = await record("ws1");
    const f = await findings.createFinding({ workspaceId: "ws1", claim: "x" });

    const confirmed = await findings.updateFinding(f.id, {
      status: "confirmed",
      evidence: [{ artifactId: a.id }],
    });
    expect(confirmed).toMatchObject({ id: f.id, status: "confirmed" });

    await expect(
      findings.updateFinding(f.id, { evidence: [{ artifactId: "gone" }] }),
    ).rejects.toThrow(findings.EvidenceError);
    expect((await findings.getFinding(f.id))?.evidence).toEqual([{ artifactId: a.id }]);
  });

  it("returns null when updating an unknown finding", async () => {
    await expect(findings.updateFinding("nope", { status: "contradicted" })).resolves.toBeNull();
  });

  it("lists per workspace, filtered by status", async () => {
    await findings.createFinding({ workspaceId: "ws1", claim: "a" });
    await findings.createFinding({ workspaceId: "ws1", claim: "b", status: "contradicted" });
    await findings.createFinding({ workspaceId: "ws2", claim: "c" });

    const all = await findings.listFindingsForWorkspace("ws1");
    expect(all.map((f) => f.claim).sort()).toEqual(["a", "b"]);
    const contradicted = await findings.listFindingsForWorkspace("ws1", "contradicted");
    expect(contradicted.map((f) => f.claim)).toEqual(["b"]);
  });
});
