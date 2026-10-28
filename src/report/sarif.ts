import { parseLocation } from "../findings/verifier.js";
import type { Report, ReportEvidence, ReportFinding } from "./types.js";

const RULE_ID = "hexforge/finding";

/** What SARIF calls a result: how it should be treated, and how serious. */
const BY_STATUS = {
  confirmed: { kind: "fail", level: "warning" },
  unverified: { kind: "review", level: "note" },
  contradicted: { kind: "pass", level: "none" },
} as const;

/** A path that stays inside the artifact, as a URI - or undefined if it doesn't. */
function relativeUri(file: string): string | undefined {
  const normalized = file.split("\\").join("/");
  const segments = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) return undefined;
  if (segments.some((s) => s === ".." || s === "")) return undefined;
  return segments.map(encodeURIComponent).join("/");
}

function baseId(artifactId: string): string {
  return `ARTIFACT_${artifactId}`;
}

function locationOf(e: ReportEvidence) {
  if (!e.location) return undefined;
  const { file, startLine, endLine } = parseLocation(e.location);
  const uri = relativeUri(file);
  if (!uri) return undefined;
  const hasRegion =
    startLine !== undefined && startLine >= 1 && (endLine ?? startLine) >= startLine;
  return {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: baseId(e.artifactId) },
      ...(hasRegion ? { region: { startLine, endLine: endLine ?? startLine } } : {}),
    },
  };
}

function resultOf(f: ReportFinding) {
  const { kind, level } = BY_STATUS[f.status];
  const locations = f.evidence.map(locationOf).filter((l) => l !== undefined);
  return {
    ruleId: RULE_ID,
    kind,
    level,
    message: { text: f.claim },
    ...(locations.length > 0 ? { locations } : {}),
    partialFingerprints: { hexforgeFindingId: f.id },
    properties: {
      hexforgeFindingId: f.id,
      status: f.status,
      confidence: f.confidence,
      source: f.source,
      reasoning: f.reasoning,
      verification: f.verification?.summary,
      evidence: f.evidence.map((e) => ({
        artifactId: e.artifactId,
        artifactKind: e.artifact?.kind,
        entity: e.entity ? `${e.entity.type} ${e.entity.name}` : undefined,
        location: e.location,
        note: e.note,
        check: e.check,
      })),
    },
  };
}

/**
 * SARIF 2.1.0, so findings can be loaded into tools that read it. Each finding
 * is one result: the claim as the message, and one location per piece of
 * evidence that names a file inside its artifact (with its line or range).
 * Confirmed means kind "fail" (level warning), unverified "review" (note) and
 * contradicted "pass" (none). Locations are relative to their artifact, named
 * by a uriBaseId; no absolute path is included.
 */
export function renderSarif(report: Report): unknown {
  const bases: Record<string, unknown> = {};
  for (const f of report.findings) {
    for (const e of f.evidence) {
      if (!e.location) continue;
      const made = e.artifact
        ? `${e.artifact.kind} produced by ${e.artifact.producedBy.agent} ${e.artifact.producedBy.operation}`
        : "an artifact that no longer exists";
      bases[baseId(e.artifactId)] = { description: { text: `Artifact ${e.artifactId}: ${made}` } };
    }
  }

  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "HexForge Gateway",
            ...(process.env.npm_package_version
              ? { version: process.env.npm_package_version }
              : {}),
            rules: [
              {
                id: RULE_ID,
                name: "Finding",
                shortDescription: { text: "A claim about the analyzed app, with its evidence" },
              },
            ],
          },
        },
        originalUriBaseIds: bases,
        results: report.findings.map(resultOf),
        properties: {
          workspace: report.workspace.name,
          targetLabel: report.workspace.targetLabel,
          generatedAt: report.generatedAt,
          evidenceVerified: report.filter.verified,
        },
      },
    ],
  };
}
