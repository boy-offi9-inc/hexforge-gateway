import type { Artifact } from "../artifacts/types.js";

export type FindingStatus = "unverified" | "confirmed" | "contradicted";
export type FindingConfidence = "low" | "medium" | "high";

/**
 * One piece of support for a claim. It points at an artifact in the same
 * workspace; tool, version, run and time all come from that artifact's own
 * provenance rather than being copied here.
 */
export interface Evidence {
  artifactId: Artifact["id"];
  /** Where inside the artifact, e.g. "com/acme/Login.java:142". */
  location?: string;
  note?: string;
}

/**
 * A claim about the target (typically from an AI step, or written by hand)
 * together with the evidence behind it. Evidence is checked when the finding
 * is saved, so a finding can only cite artifacts that really exist.
 */
export interface Finding {
  id: string;
  workspaceId: string;
  claim: string;
  status: FindingStatus;
  confidence?: FindingConfidence;
  reasoning?: string;
  evidence: Evidence[];
  /** Who made the claim. */
  source: "user" | "ai" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface FindingInput {
  workspaceId: string;
  claim: string;
  status?: FindingStatus;
  confidence?: FindingConfidence;
  reasoning?: string;
  evidence?: Evidence[];
  source?: Finding["source"];
}

export type FindingUpdate = Partial<
  Pick<Finding, "status" | "confidence" | "reasoning" | "evidence">
>;
