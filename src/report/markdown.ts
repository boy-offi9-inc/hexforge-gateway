import type { Report, ReportEvidence, ReportFinding } from "./types.js";

/**
 * Claims, reasoning and notes can come from an AI, so they are escaped rather
 * than trusted: no stray markup, links or HTML from a finding's text.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_<>[\]|]/g, (c) => `\\${c}`);
}

/** A multi-line string as a blockquote. */
function quote(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${escapeMarkdown(line)}`)
    .join("\n");
}

function code(text: string): string {
  return `\`${text.replace(/[`\r\n]/g, "'")}\``;
}

function describeArtifact(e: ReportEvidence): string {
  if (!e.artifact) return "artifact no longer exists";
  const { kind, producedBy, tools } = e.artifact;
  const versions = (tools ?? []).map((t) => (t.version ? `${t.tool} ${t.version}` : t.tool));
  const made = `${producedBy.agent} ${producedBy.operation}`;
  return `${kind} (${[made, ...versions].join(", ")})`;
}

function renderEvidence(e: ReportEvidence, index: number): string {
  const where = e.location ? code(e.location) : "no location";
  const about = e.entityId
    ? e.entity
      ? ` - ${e.entity.type} ${code(e.entity.name)}`
      : " - entity no longer exists"
    : "";
  const lines = [`${index + 1}. ${where}${about}`];
  if (e.check) lines.push(`   - **${e.check.status}**: ${escapeMarkdown(e.check.reason)}`);
  lines.push(`   - Artifact: ${escapeMarkdown(describeArtifact(e))}`);
  if (e.note) lines.push(`   - Note: ${escapeMarkdown(e.note)}`);
  return lines.join("\n");
}

function renderFinding(f: ReportFinding, index: number): string {
  const head = [`**${f.status}**`];
  if (f.confidence) head.push(`confidence ${f.confidence}`);
  head.push(`by ${f.source}`);
  const parts = [`### ${index + 1}. ${head.join(" - ")}`, "", quote(f.claim), ""];
  if (f.reasoning) parts.push(`Reasoning: ${escapeMarkdown(f.reasoning.replace(/\s+/g, " "))}`, "");
  if (f.verification) {
    parts.push(
      `Verification: **${f.verification.summary}** (checked ${f.verification.checkedAt})`,
      "",
    );
  }
  parts.push(`Recorded ${f.createdAt}, updated ${f.updatedAt}. Finding id ${code(f.id)}.`, "");
  parts.push(
    f.evidence.length > 0
      ? ["Evidence:", "", ...f.evidence.map(renderEvidence)].join("\n")
      : "Evidence: none.",
  );
  return parts.join("\n");
}

/** A readable report: summary first, then every finding with its evidence and checks. */
export function renderMarkdown(report: Report): string {
  const { summary, filter } = report;
  const out = [
    `# Findings report: ${escapeMarkdown(report.workspace.targetLabel || report.workspace.name)}`,
    "",
    `Generated ${report.generatedAt} from workspace ${code(report.workspace.name)}.`,
  ];
  if (filter.status) out.push(`Only findings with status **${filter.status}** are included.`);
  out.push(
    filter.verified
      ? "Each finding's evidence was re-checked against the files it cites when this report was generated."
      : "Evidence was not re-checked for this report.",
    "",
    "A *verified* check means the cited file and line exist. It does not mean the claim is true.",
    "",
    "## Summary",
    "",
    `- Findings: ${summary.findings}`,
    `- By status: ${summary.byStatus.confirmed} confirmed, ${summary.byStatus.unverified} unverified, ${summary.byStatus.contradicted} contradicted`,
  );
  if (summary.verification) {
    const v = summary.verification;
    out.push(
      `- Evidence checks: ${v.verified} verified, ${v.partial} partial, ${v.unverified} unverified, ${v.failed} failed`,
    );
  }
  out.push("", "## Findings", "");
  out.push(
    report.findings.length > 0
      ? report.findings.map(renderFinding).join("\n\n")
      : "No findings recorded.",
  );
  return `${out.join("\n")}\n`;
}
