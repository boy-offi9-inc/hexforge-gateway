import { nanoid } from "nanoid";
import * as localStore from "../providers/local-storage.provider.js";
import { eventBus } from "../events/event-bus.js";
import { getArtifact } from "../artifacts/artifact.service.js";
import type { Evidence, Finding, FindingInput, FindingStatus, FindingUpdate } from "./types.js";

// Local storage only, like artifacts: there is no Supabase table for these yet.
const COLLECTION = "findings";

/** The finding's evidence is invalid. Callers (the routes) turn this into a 400. */
export class EvidenceError extends Error {}

/** Every cited artifact must exist and belong to the same workspace as the finding. */
async function checkEvidence(workspaceId: string, evidence: Evidence[]): Promise<void> {
  const missing: string[] = [];
  for (const artifactId of new Set(evidence.map((e) => e.artifactId))) {
    const artifact = await getArtifact(artifactId);
    if (!artifact || artifact.workspaceId !== workspaceId) missing.push(artifactId);
  }
  if (missing.length > 0) {
    throw new EvidenceError(
      `Evidence cites artifact(s) not found in this workspace: ${missing.join(", ")}`,
    );
  }
}

function checkConfirmed(status: FindingStatus, evidence: Evidence[]): void {
  if (status === "confirmed" && evidence.length === 0) {
    throw new EvidenceError("A confirmed finding needs at least one piece of evidence");
  }
}

export async function createFinding(input: FindingInput): Promise<Finding> {
  const evidence = input.evidence ?? [];
  const status = input.status ?? "unverified";
  checkConfirmed(status, evidence);
  await checkEvidence(input.workspaceId, evidence);

  const now = new Date().toISOString();
  const finding: Finding = {
    id: nanoid(12),
    workspaceId: input.workspaceId,
    claim: input.claim,
    status,
    confidence: input.confidence,
    reasoning: input.reasoning,
    evidence,
    source: input.source ?? "user",
    createdAt: now,
    updatedAt: now,
  };
  await localStore.upsertRecord(COLLECTION, finding);
  eventBus.emit("finding.created", { finding });
  return finding;
}

export async function getFinding(id: string): Promise<Finding | null> {
  return localStore.getRecord<Finding>(COLLECTION, id);
}

export async function listFindingsForWorkspace(
  workspaceId: string,
  status?: FindingStatus,
): Promise<Finding[]> {
  const all = await localStore.listRecords<Finding>(COLLECTION);
  return all
    .filter((f) => f.workspaceId === workspaceId && (!status || f.status === status))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Null if the finding doesn't exist. The rules are re-checked against the updated result. */
export async function updateFinding(id: string, update: FindingUpdate): Promise<Finding | null> {
  const existing = await getFinding(id);
  if (!existing) return null;

  const evidence = update.evidence ?? existing.evidence;
  const status = update.status ?? existing.status;
  checkConfirmed(status, evidence);
  if (update.evidence) await checkEvidence(existing.workspaceId, evidence);

  const updated: Finding = {
    ...existing,
    ...update,
    status,
    evidence,
    updatedAt: new Date().toISOString(),
  };
  await localStore.upsertRecord(COLLECTION, updated);
  eventBus.emit("finding.updated", { finding: updated });
  return updated;
}
