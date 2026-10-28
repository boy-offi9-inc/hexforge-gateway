import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Real local storage in a throwaway DATA_DIR with a fresh module graph per
// test, with the real artifact, graph, finding and verifier modules next to
// it, and a real directory for the artifact to point at - so the report is
// built from the same pieces the Gateway uses.
let dataDir: string;
let root: string;
const workspace = { id: "ws1", name: "demo", targetLabel: "com.acme.app" };

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-report-data-"));
  root = await mkdtemp(path.join(tmpdir(), "hexforge-report-out-"));
  await mkdir(path.join(root, "sources", "com", "acme"), { recursive: true });
  await writeFile(path.join(root, "sources", "com", "acme", "Login.java"), "a\nb\nc\n");
  vi.resetModules();
  vi.stubEnv("DATA_DIR", dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

async function setup() {
  const artifacts = await import("../src/artifacts/artifact.service.js");
  const graph = await import("../src/graph/graph.service.js");
  const findings = await import("../src/findings/finding.service.js");
  const { buildReport } = await import("../src/report/builder.js");

  const artifact = await artifacts.recordArtifact({
    workspaceId: "ws1",
    kind: "java-sources",
    path: root,
    pathType: "directory",
    source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
    tools: [{ tool: "jadx", version: "1.5.1" }],
  });
  const { entity } = await graph.upsertEntity({
    workspaceId: "ws1",
    type: "class",
    name: "com.acme.Login",
    artifactIds: [artifact.id],
  });
  const make = (claim: string, over: Record<string, unknown> = {}) =>
    findings.createFinding({ workspaceId: "ws1", claim, ...over });
  return { artifact, entity, make, buildReport };
}

describe("buildReport", () => {
  it("counts findings by status and lists confirmed, unverified, then contradicted", async () => {
    const { artifact, make, buildReport } = await setup();
    const cite = [{ artifactId: artifact.id, location: "com/acme/Login.java:2" }];
    await make("settled?", { status: "unverified" });
    await make("refuted", { status: "contradicted" });
    await make("proven", { status: "confirmed", evidence: cite });

    const report = await buildReport(workspace);

    expect(report.findings.map((f) => f.claim)).toEqual(["proven", "settled?", "refuted"]);
    expect(report.summary).toMatchObject({
      findings: 3,
      byStatus: { confirmed: 1, unverified: 1, contradicted: 1 },
    });
    expect(report.workspace).toEqual(workspace);
  });

  it("enriches evidence with what produced it, the entity, and a fresh check", async () => {
    const { artifact, entity, make, buildReport } = await setup();
    await make("cleartext login", {
      status: "confirmed",
      evidence: [
        {
          artifactId: artifact.id,
          entityId: entity.id,
          location: "com/acme/Login.java:2",
          note: "url",
        },
      ],
    });

    const [finding] = (await buildReport(workspace)).findings;

    expect(finding?.verification?.summary).toBe("verified");
    expect(finding?.evidence[0]).toMatchObject({
      artifactId: artifact.id,
      artifact: {
        kind: "java-sources",
        producedBy: { agent: "jadx", operation: "decompile", capability: "java.decompile" },
        tools: [{ tool: "jadx", version: "1.5.1" }],
      },
      entity: { id: entity.id, type: "class", name: "com.acme.Login" },
      location: "com/acme/Login.java:2",
      note: "url",
      check: { status: "verified" },
    });
  });

  it("reports a failed check for a location that is no longer there", async () => {
    const { artifact, make, buildReport } = await setup();
    await make("stale", {
      status: "confirmed",
      evidence: [{ artifactId: artifact.id, location: "com/acme/Login.java:99" }],
    });

    const report = await buildReport(workspace);

    expect(report.findings[0]?.verification?.summary).toBe("failed");
    expect(report.summary.verification).toEqual({
      verified: 0,
      partial: 0,
      unverified: 0,
      failed: 1,
    });
  });

  it("includes no filesystem path anywhere in the report", async () => {
    const { artifact, entity, make, buildReport } = await setup();
    await make("x", {
      status: "confirmed",
      evidence: [
        { artifactId: artifact.id, entityId: entity.id, location: "com/acme/Login.java:1" },
      ],
    });
    await make("y", {
      evidence: [{ artifactId: artifact.id, location: "com/acme/Login.java:77" }],
    });

    const text = JSON.stringify(await buildReport(workspace));

    expect(text).not.toContain(root);
    expect(text).not.toContain(dataDir);
  });

  it("skips the file checks when verify is false", async () => {
    const { artifact, make, buildReport } = await setup();
    await make("x", {
      status: "confirmed",
      evidence: [{ artifactId: artifact.id, location: "com/acme/Login.java:2" }],
    });

    const report = await buildReport(workspace, { verify: false });

    expect(report.filter.verified).toBe(false);
    expect(report.summary.verification).toBeUndefined();
    expect(report.findings[0]?.verification).toBeUndefined();
    expect(report.findings[0]?.evidence[0]?.check).toBeUndefined();
  });

  it("includes only the requested status", async () => {
    const { artifact, make, buildReport } = await setup();
    await make("open question");
    await make("proven", {
      status: "confirmed",
      evidence: [{ artifactId: artifact.id }],
    });

    const report = await buildReport(workspace, { status: "confirmed" });

    expect(report.findings.map((f) => f.claim)).toEqual(["proven"]);
    expect(report.filter.status).toBe("confirmed");
    expect(report.summary.byStatus).toEqual({ confirmed: 1, unverified: 0, contradicted: 0 });
  });

  it("is an empty report, not an error, for a workspace with no findings", async () => {
    const { buildReport } = await setup();

    const report = await buildReport({ ...workspace, id: "ws-empty" });

    expect(report.findings).toEqual([]);
    expect(report.summary.findings).toBe(0);
  });
});
