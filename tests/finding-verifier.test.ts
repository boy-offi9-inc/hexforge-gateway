import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkLocation, parseLocation, summarize } from "../src/findings/verifier.js";
import type { EvidenceCheck, Finding } from "../src/findings/types.js";

describe("parseLocation", () => {
  it("splits a path from an optional line, range and column", () => {
    expect(parseLocation("com/acme/Api.java")).toEqual({ file: "com/acme/Api.java" });
    expect(parseLocation("com/acme/Api.java:12")).toEqual({
      file: "com/acme/Api.java",
      startLine: 12,
      endLine: undefined,
    });
    expect(parseLocation("com/acme/Api.java:12-20")).toMatchObject({ startLine: 12, endLine: 20 });
    expect(parseLocation(" com/acme/Api.java:12:5 ")).toMatchObject({
      file: "com/acme/Api.java",
      startLine: 12,
    });
  });

  it("treats a colon that isn't followed by a number as part of the path", () => {
    expect(parseLocation("weird:name.java")).toEqual({ file: "weird:name.java" });
    expect(parseLocation("a:b.java:7")).toMatchObject({ file: "a:b.java", startLine: 7 });
  });
});

describe("summarize", () => {
  const item = (status: EvidenceCheck["status"]): EvidenceCheck => ({
    index: 0,
    artifactId: "a",
    status,
    reason: "",
  });

  it("is failed if anything failed, verified only if everything verified", () => {
    expect(summarize([item("verified"), item("failed"), item("unverified")])).toBe("failed");
    expect(summarize([item("verified"), item("verified")])).toBe("verified");
  });

  it("is partial when some verified and the rest could not be checked", () => {
    expect(summarize([item("verified"), item("unverified")])).toBe("partial");
  });

  it("is unverified when nothing verified, including no evidence at all", () => {
    expect(summarize([item("unverified")])).toBe("unverified");
    expect(summarize([])).toBe("unverified");
  });
});

describe("checkLocation", () => {
  let root: string;
  let outside: string;
  const dir = () => ({ path: root, pathType: "directory" as const });

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hexforge-verifier-"));
    outside = await mkdtemp(path.join(tmpdir(), "hexforge-verifier-outside-"));
    await mkdir(path.join(root, "sources", "com", "acme"), { recursive: true });
    await writeFile(path.join(root, "sources", "com", "acme", "Api.java"), "a\nb\nc\n");
    await mkdir(path.join(root, "res"), { recursive: true });
    await writeFile(path.join(root, "res", "strings.xml"), "one\ntwo");
    await writeFile(path.join(outside, "secret.txt"), "top secret\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("verifies a file that exists, with or without a line", async () => {
    expect((await checkLocation(dir(), "com/acme/Api.java")).status).toBe("verified");
    expect((await checkLocation(dir(), "com/acme/Api.java:2")).status).toBe("verified");
    expect((await checkLocation(dir(), "com/acme/Api.java:1-3")).status).toBe("verified");
  });

  it("resolves against the artifact directory first, then its sources/ folder", async () => {
    expect((await checkLocation(dir(), "res/strings.xml:2")).status).toBe("verified");
    expect((await checkLocation(dir(), "sources/com/acme/Api.java:3")).status).toBe("verified");
  });

  it("counts lines whether or not the file ends with a newline", async () => {
    // strings.xml has two lines and no trailing newline; Api.java has three and one.
    expect((await checkLocation(dir(), "res/strings.xml:2")).status).toBe("verified");
    expect((await checkLocation(dir(), "res/strings.xml:3")).status).toBe("failed");
    expect((await checkLocation(dir(), "com/acme/Api.java:3")).status).toBe("verified");
    expect((await checkLocation(dir(), "com/acme/Api.java:4")).status).toBe("failed");
  });

  it("fails a line or range that is past the end, backwards, or zero", async () => {
    const past = await checkLocation(dir(), "com/acme/Api.java:99");
    expect(past).toMatchObject({ status: "failed" });
    expect(past.reason).toContain("past the end of the file (3 lines)");
    expect((await checkLocation(dir(), "com/acme/Api.java:2-9")).status).toBe("failed");
    expect((await checkLocation(dir(), "com/acme/Api.java:3-1")).reason).toContain("backwards");
    expect((await checkLocation(dir(), "com/acme/Api.java:0")).reason).toContain("start at 1");
  });

  it("fails a file that isn't there", async () => {
    const result = await checkLocation(dir(), "com/acme/Missing.java:1");
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("no such file in the artifact");
  });

  it("never reads outside the artifact: parent paths, absolute paths and symlinks", async () => {
    const escape = path.relative(root, path.join(outside, "secret.txt"));
    expect((await checkLocation(dir(), escape)).reason).toContain("outside the artifact");
    expect((await checkLocation(dir(), path.join(outside, "secret.txt"))).status).toBe("failed");

    await symlink(outside, path.join(root, "link"));
    const viaLink = await checkLocation(dir(), "link/secret.txt:1");
    expect(viaLink).toMatchObject({ status: "failed" });
    expect(viaLink.reason).toContain("outside the artifact");
  });

  it("leaves a single-file artifact and a missing directory unverified", async () => {
    const singleFile = { path: path.join(root, "res", "strings.xml"), pathType: "file" as const };
    expect((await checkLocation(singleFile, "x:1")).status).toBe("unverified");
    const missing = { path: path.join(root, "nope"), pathType: "directory" as const };
    const gone = await checkLocation(missing, "x:1");
    expect(gone).toMatchObject({ status: "unverified" });
    expect(gone.reason).toContain("missing on disk");
  });

  it("doesn't read a file over the size limit, so its line stays unverified", async () => {
    const big = await checkLocation(dir(), "com/acme/Api.java:2", 3);
    expect(big.status).toBe("unverified");
    expect(big.reason).toContain("larger than 3 bytes");
    // Without a line there is nothing to read, so size doesn't matter.
    expect((await checkLocation(dir(), "com/acme/Api.java", 3)).status).toBe("verified");
  });
});

// verifyFinding looks the cited artifacts up, so it runs against real local
// storage in a throwaway DATA_DIR with a fresh module graph per test (same
// approach as finding-service.test.ts).
describe("verifyFinding", () => {
  let dataDir: string;
  let root: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-verify-data-"));
    root = await mkdtemp(path.join(tmpdir(), "hexforge-verify-out-"));
    await mkdir(path.join(root, "sources", "com", "acme"), { recursive: true });
    await writeFile(path.join(root, "sources", "com", "acme", "Api.java"), "a\nb\nc\n");
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
    const verifier = await import("../src/findings/verifier.js");
    const artifact = await artifacts.recordArtifact({
      workspaceId: "ws1",
      kind: "java-sources",
      path: root,
      pathType: "directory",
      source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
    });
    const finding = (evidence: Finding["evidence"]): Finding => ({
      id: "f1",
      workspaceId: "ws1",
      claim: "x",
      status: "confirmed",
      evidence,
      source: "ai",
      createdAt: "",
      updatedAt: "",
    });
    return { artifact, verifier, finding };
  }

  it("reports every evidence item and a summary, and leaves the finding alone", async () => {
    const { artifact, verifier, finding } = await setup();
    const f = finding([
      { artifactId: artifact.id, entityId: "e1", location: "com/acme/Api.java:2" },
      { artifactId: artifact.id, location: "com/acme/Api.java:50" },
      { artifactId: artifact.id },
    ]);

    const report = await verifier.verifyFinding(f);

    expect(report).toMatchObject({ findingId: "f1", summary: "failed" });
    expect(report.items.map((i) => i.status)).toEqual(["verified", "failed", "unverified"]);
    expect(report.items[0]).toMatchObject({ index: 0, artifactId: artifact.id, entityId: "e1" });
    expect(f.status).toBe("confirmed");
  });

  it("is verified when every item checks out, and partial when some can't be checked", async () => {
    const { artifact, verifier, finding } = await setup();
    const good = { artifactId: artifact.id, location: "com/acme/Api.java:1" };

    const allGood = await verifier.verifyFinding(finding([good, good]));
    const mixed = await verifier.verifyFinding(finding([good, { artifactId: artifact.id }]));

    expect(allGood.summary).toBe("verified");
    expect(mixed.summary).toBe("partial");
  });

  it("fails evidence whose artifact is gone or belongs to another workspace", async () => {
    const { artifact, verifier, finding } = await setup();
    const other = await (
      await import("../src/artifacts/artifact.service.js")
    ).recordArtifact({
      workspaceId: "ws2",
      kind: "apk",
      path: "/ws/ws2/out.apk",
      pathType: "file",
      source: { taskId: "t2", agent: "apktool", operation: "build", capability: "android.rebuild" },
    });

    const report = await verifier.verifyFinding(
      finding([{ artifactId: "ghost" }, { artifactId: other.id }, { artifactId: artifact.id }]),
    );

    expect(report.items.map((i) => i.status)).toEqual(["failed", "failed", "unverified"]);
    expect(report.items[0]?.reason).toContain("no longer exists");
  });

  it("is unverified for a finding with no evidence", async () => {
    const { verifier, finding } = await setup();

    expect(await verifier.verifyFinding(finding([]))).toMatchObject({
      summary: "unverified",
      items: [],
    });
  });
});
