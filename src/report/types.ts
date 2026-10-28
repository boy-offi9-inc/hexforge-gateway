import type { ToolProvenance } from "../capabilities/types.js";
import type { FindingStatus, VerificationReport, VerificationStatus } from "../findings/types.js";

export type ReportFormat = "json" | "markdown" | "sarif";

export interface ReportOptions {
  /** Only include findings with this status. */
  status?: FindingStatus;
  /** Re-check each finding's evidence against the files it cites (default true). */
  verify?: boolean;
}

/** One piece of evidence with the context a reader needs, and no filesystem paths. */
export interface ReportEvidence {
  artifactId: string;
  /** Missing when the cited artifact no longer exists. */
  artifact?: {
    kind: string;
    producedBy: { agent: string; operation: string; capability: string };
    tools?: ToolProvenance[];
  };
  entityId?: string;
  /** Missing when the cited entity no longer exists. */
  entity?: { id: string; type: string; name: string };
  location?: string;
  note?: string;
  /** This item's verification result, when the report was verified. */
  check?: { status: VerificationStatus; reason: string };
}

export interface ReportFinding {
  id: string;
  claim: string;
  status: FindingStatus;
  confidence?: string;
  reasoning?: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  verification?: { summary: VerificationReport["summary"]; checkedAt: string };
  evidence: ReportEvidence[];
}

export interface Report {
  generatedAt: string;
  workspace: { id: string; name: string; targetLabel: string };
  filter: { status?: FindingStatus; verified: boolean };
  summary: {
    findings: number;
    byStatus: Record<FindingStatus, number>;
    /** Only when verified. */
    verification?: Record<VerificationReport["summary"], number>;
  };
  findings: ReportFinding[];
}
