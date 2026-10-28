import { describe, expect, it } from "vitest";
import { escapeMarkdown, renderMarkdown } from "../src/report/markdown.js";
import { renderSarif } from "../src/report/sarif.js";
import type { Report, ReportEvidence, ReportFinding } from "../src/report/types.js";

// Both renderers are pure (a Report in, text or an object out), so these tests
// build a Report by hand and need no storage, events or mocks.
const evidence = (over: Partial<ReportEvidence> = {}): ReportEvidence => ({
  artifactId: "ar1",
  artifact: {
    kind: "java-sources",
    producedBy: { agent: "jadx", operation: "decompile", capability: "java.decompile" },
    tools: [{ tool: "jadx", version: "1.5.1" }],
  },
  entityId: "e1",
  entity: { id: "e1", type: "class", name: "com.acme.Login" },
  location: "com/acme/Login.java:42",
  note: "the endpoint URL",
  check: { status: "verified", reason: "the file exists and line 42 is within it (210 lines)" },
  ...over,
});

const finding = (over: Partial<ReportFinding> = {}): ReportFinding => ({
  id: "f1",
  claim: "The login request is sent over cleartext HTTP",
  status: "confirmed",
  confidence: "medium",
  reasoning: "Login.java builds the URL with an http:// scheme.",
  source: "ai",
  createdAt: "2026-10-24T10:00:00.000Z",
  updatedAt: "2026-10-24T11:00:00.000Z",
  verification: { summary: "verified", checkedAt: "2026-10-24T12:00:00.000Z" },
  evidence: [evidence()],
  ...over,
});

const report = (findings: ReportFinding[], over: Partial<Report> = {}): Report => ({
  generatedAt: "2026-10-24T12:00:00.000Z",
  workspace: { id: "ws1", name: "demo", targetLabel: "com.acme.app" },
  filter: { verified: true },
  summary: {
    findings: findings.length,
    byStatus: { confirmed: 1, unverified: 0, contradicted: 0 },
    verification: { verified: 1, partial: 0, unverified: 0, failed: 0 },
  },
  findings,
  ...over,
});

describe("renderMarkdown", () => {
  it("leads with the target and a summary, then each finding with its evidence", () => {
    const md = renderMarkdown(report([finding()]));

    expect(md).toContain("# Findings report: com.acme.app");
    expect(md).toContain("- Findings: 1");
    expect(md).toContain("- By status: 1 confirmed, 0 unverified, 0 contradicted");
    expect(md).toContain("- Evidence checks: 1 verified, 0 partial, 0 unverified, 0 failed");
    expect(md).toContain("### 1. **confirmed** - confidence medium - by ai");
    expect(md).toContain("> The login request is sent over cleartext HTTP");
    expect(md).toContain("`com/acme/Login.java:42` - class `com.acme.Login`");
    expect(md).toContain("**verified**: the file exists and line 42 is within it (210 lines)");
    expect(md).toContain("Artifact: java-sources (jadx decompile, jadx 1.5.1)");
    expect(md).toContain("Note: the endpoint URL");
  });

  it("says plainly that verified means the place exists, not that the claim is true", () => {
    expect(renderMarkdown(report([finding()]))).toContain("does not mean the claim is true");
  });

  it("escapes markup in claims, reasoning and notes instead of passing it through", () => {
    const md = renderMarkdown(
      report([
        finding({
          claim: "<script>alert(1)</script> *bold* [x](http://evil)",
          reasoning: "see <img src=x> and `code`",
          evidence: [evidence({ note: "a | b_c" })],
        }),
      ]),
    );

    // Every "<" in the output is escaped (preceded by a backslash).
    expect(md).not.toMatch(/(^|[^\\])</);
    expect(md).toContain("\\<script\\>alert(1)\\</script\\> \\*bold\\* \\[x\\](http://evil)");
    expect(md).toContain("a \\| b\\_c");
    expect(escapeMarkdown("a_b")).toBe("a\\_b");
  });

  it("keeps a multi-line claim inside the blockquote", () => {
    const md = renderMarkdown(report([finding({ claim: "line one\nline two" })]));

    expect(md).toContain("> line one\n> line two");
  });

  it("describes evidence whose artifact or entity is gone, and evidence with no location", () => {
    const md = renderMarkdown(
      report([
        finding({
          evidence: [
            evidence({
              artifact: undefined,
              entity: undefined,
              location: undefined,
              note: undefined,
            }),
          ],
        }),
      ]),
    );

    expect(md).toContain("1. no location - entity no longer exists");
    expect(md).toContain("Artifact: artifact no longer exists");
  });

  it("handles no findings, a status filter, and a report that wasn't verified", () => {
    const md = renderMarkdown(
      report([], {
        filter: { status: "confirmed", verified: false },
        summary: {
          findings: 0,
          byStatus: { confirmed: 0, unverified: 0, contradicted: 0 },
        },
      }),
    );

    expect(md).toContain("No findings recorded.");
    expect(md).toContain("Only findings with status **confirmed** are included.");
    expect(md).toContain("Evidence was not re-checked for this report.");
    expect(md).not.toContain("Evidence checks:");
  });

  it("never prints a filesystem path", () => {
    expect(renderMarkdown(report([finding()]))).not.toMatch(/\/data\/|\/home\/|\/sdcard\/|\/tmp\//);
  });
});

describe("renderSarif", () => {
  const sarif = (r: Report) =>
    renderSarif(r) as {
      version: string;
      $schema: string;
      runs: {
        tool: { driver: { name: string; rules: { id: string }[] } };
        originalUriBaseIds: Record<string, { description: { text: string } }>;
        results: Record<string, any>[];
        properties: Record<string, unknown>;
      }[];
    };

  it("is a SARIF 2.1.0 log with one run, the tool and a rule", () => {
    const log = sarif(report([finding()]));

    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-2.1.0");
    expect(log.runs).toHaveLength(1);
    expect(log.runs[0]?.tool.driver.name).toBe("HexForge Gateway");
    expect(log.runs[0]?.tool.driver.rules.map((r) => r.id)).toEqual(["hexforge/finding"]);
  });

  it("makes a result per finding: the claim as the message, status as kind and level", () => {
    const log = sarif(
      report([
        finding({ id: "a", status: "confirmed" }),
        finding({ id: "b", status: "unverified" }),
        finding({ id: "c", status: "contradicted" }),
      ]),
    );

    const results = log.runs[0]?.results ?? [];
    expect(results.map((r) => [r.kind, r.level])).toEqual([
      ["fail", "warning"],
      ["review", "note"],
      ["pass", "none"],
    ]);
    expect(results[0]).toMatchObject({
      ruleId: "hexforge/finding",
      message: { text: "The login request is sent over cleartext HTTP" },
      partialFingerprints: { hexforgeFindingId: "a" },
    });
  });

  it("turns a location into a file, a line and a range, relative to its artifact", () => {
    const log = sarif(
      report([
        finding({
          evidence: [
            evidence({ location: "com/acme/Login.java:42" }),
            evidence({ location: "com/acme/Api.java:12-20" }),
            evidence({ location: "res/values/strings.xml" }),
          ],
        }),
      ]),
    );

    const [a, b, c] = log.runs[0]?.results[0]?.locations ?? [];
    expect(a.physicalLocation).toEqual({
      artifactLocation: { uri: "com/acme/Login.java", uriBaseId: "ARTIFACT_ar1" },
      region: { startLine: 42, endLine: 42 },
    });
    expect(b.physicalLocation.region).toEqual({ startLine: 12, endLine: 20 });
    expect(c.physicalLocation).toEqual({
      artifactLocation: { uri: "res/values/strings.xml", uriBaseId: "ARTIFACT_ar1" },
    });
  });

  it("describes each artifact once under originalUriBaseIds, without a path", () => {
    const log = sarif(report([finding()]));

    expect(log.runs[0]?.originalUriBaseIds).toEqual({
      ARTIFACT_ar1: {
        description: { text: "Artifact ar1: java-sources produced by jadx decompile" },
      },
    });
  });

  it("leaves out locations that aren't a safe relative path, and evidence with no location", () => {
    const log = sarif(
      report([
        finding({
          evidence: [
            evidence({ location: "../../etc/passwd:1" }),
            evidence({ location: "/data/data/app/x.java:3" }),
            evidence({ location: "a//b.java:3" }),
            evidence({ location: undefined }),
          ],
        }),
      ]),
    );

    expect(log.runs[0]?.results[0]).not.toHaveProperty("locations");
  });

  it("drops a region it can't make valid (line 0, or a backwards range)", () => {
    const log = sarif(
      report([
        finding({
          evidence: [evidence({ location: "A.java:0" }), evidence({ location: "B.java:9-3" })],
        }),
      ]),
    );

    const [zero, backwards] = log.runs[0]?.results[0]?.locations ?? [];
    expect(zero.physicalLocation).not.toHaveProperty("region");
    expect(backwards.physicalLocation).not.toHaveProperty("region");
  });

  it("carries the verification, entity and notes along as properties", () => {
    const log = sarif(report([finding()]));
    const props = log.runs[0]?.results[0]?.properties;

    expect(props).toMatchObject({
      hexforgeFindingId: "f1",
      status: "confirmed",
      source: "ai",
      verification: "verified",
    });
    expect(props.evidence[0]).toMatchObject({
      artifactKind: "java-sources",
      entity: "class com.acme.Login",
      note: "the endpoint URL",
    });
    expect(log.runs[0]?.properties).toMatchObject({ workspace: "demo", evidenceVerified: true });
  });

  it("is valid JSON and never contains an absolute path", () => {
    const text = JSON.stringify(renderSarif(report([finding()])));

    expect(() => JSON.parse(text)).not.toThrow();
    expect(text).not.toMatch(/\/data\/|\/home\/|\/sdcard\/|\/tmp\//);
  });
});
