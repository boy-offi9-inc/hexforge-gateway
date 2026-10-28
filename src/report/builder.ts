import { getArtifact } from "../artifacts/artifact.service.js";
import * as findingService from "../findings/finding.service.js";
import type { Finding, FindingStatus, VerificationReport } from "../findings/types.js";
import { verifyFinding } from "../findings/verifier.js";
import { getEntity } from "../graph/graph.service.js";
import type { Report, ReportEvidence, ReportFinding, ReportOptions } from "./types.js";

const STATUS_ORDER: FindingStatus[] = ["confirmed", "unverified", "contradicted"];

/**
 * Collects a workspace's findings, with each piece of evidence enriched from
 * the artifact and graph entity it cites (what produced it, with which tool
 * versions, what the entity is called) and - unless `verify` is false - a
 * fresh check against the cited files.
 *
 * Nothing here is stored and nothing is changed: it is a view of the current
 * state. Artifact paths are deliberately left out, so a report doesn't reveal
 * where the analysis lives on disk.
 */
export async function buildReport(
  workspace: { id: string; name: string; targetLabel: string },
  options: ReportOptions = {},
): Promise<Report> {
  const verify = options.verify ?? true;
  const found = await findingService.listFindingsForWorkspace(
    workspace.id,
    options.status ? { status: options.status } : {},
  );
  const ordered = [...found].sort(
    (a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );

  const artifacts = new Map<string, Awaited<ReturnType<typeof getArtifact>>>();
  const entities = new Map<string, Awaited<ReturnType<typeof getEntity>>>();
  const artifactOf = async (id: string) => {
    if (!artifacts.has(id)) artifacts.set(id, await getArtifact(id));
    return artifacts.get(id) ?? null;
  };
  const entityOf = async (id: string) => {
    if (!entities.has(id)) entities.set(id, await getEntity(id));
    return entities.get(id) ?? null;
  };

  const byStatus: Record<FindingStatus, number> = { confirmed: 0, unverified: 0, contradicted: 0 };
  const verification: Record<VerificationReport["summary"], number> = {
    verified: 0,
    partial: 0,
    unverified: 0,
    failed: 0,
  };

  const findings: ReportFinding[] = [];
  for (const finding of ordered) {
    byStatus[finding.status]++;
    const checked = verify ? await verifyFinding(finding) : undefined;
    if (checked) verification[checked.summary]++;

    const evidence: ReportEvidence[] = [];
    for (const [index, e] of finding.evidence.entries()) {
      const artifact = await artifactOf(e.artifactId);
      const entity = e.entityId ? await entityOf(e.entityId) : null;
      const item = checked?.items[index];
      evidence.push({
        artifactId: e.artifactId,
        artifact:
          artifact && artifact.workspaceId === workspace.id
            ? {
                kind: artifact.kind,
                producedBy: {
                  agent: artifact.source.agent,
                  operation: artifact.source.operation,
                  capability: artifact.source.capability,
                },
                tools: artifact.tools,
              }
            : undefined,
        entityId: e.entityId,
        entity:
          entity && entity.workspaceId === workspace.id
            ? { id: entity.id, type: entity.type, name: entity.name }
            : undefined,
        location: e.location,
        note: e.note,
        check: item ? { status: item.status, reason: item.reason } : undefined,
      });
    }
    findings.push(toReportFinding(finding, evidence, checked));
  }

  return {
    generatedAt: new Date().toISOString(),
    workspace: { id: workspace.id, name: workspace.name, targetLabel: workspace.targetLabel },
    filter: { status: options.status, verified: verify },
    summary: {
      findings: findings.length,
      byStatus,
      verification: verify ? verification : undefined,
    },
    findings,
  };
}

function toReportFinding(
  finding: Finding,
  evidence: ReportEvidence[],
  checked: VerificationReport | undefined,
): ReportFinding {
  return {
    id: finding.id,
    claim: finding.claim,
    status: finding.status,
    confidence: finding.confidence,
    reasoning: finding.reasoning,
    source: finding.source,
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
    verification: checked ? { summary: checked.summary, checkedAt: checked.checkedAt } : undefined,
    evidence,
  };
}
