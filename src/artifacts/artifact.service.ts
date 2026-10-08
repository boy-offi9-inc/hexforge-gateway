import { nanoid } from "nanoid";
import * as localStore from "../providers/local-storage.provider.js";
import { eventBus } from "../events/event-bus.js";
import type { Artifact, ArtifactInput } from "./types.js";

// Local storage only, for now: unlike knowledge entries there is no Supabase
// table for artifacts yet, so STORAGE_BACKEND=supabase does not change this.
const COLLECTION = "artifacts";

/**
 * Records an artifact. Producing the same kind at the same path again (a
 * re-run of jadx overwrites its output directory) updates the existing
 * record instead of piling up duplicates: the id and createdAt stay, the
 * source and tools describe the latest run.
 */
export async function recordArtifact(input: ArtifactInput): Promise<Artifact> {
  const now = new Date().toISOString();
  const existing = await localStore.findRecord<Artifact>(
    COLLECTION,
    (a) => a.workspaceId === input.workspaceId && a.kind === input.kind && a.path === input.path,
  );

  if (existing) {
    const updated: Artifact = { ...existing, ...input, tools: input.tools, updatedAt: now };
    await localStore.upsertRecord(COLLECTION, updated);
    eventBus.emit("artifact.updated", { artifact: updated });
    return updated;
  }

  const artifact: Artifact = { id: nanoid(12), ...input, createdAt: now, updatedAt: now };
  await localStore.upsertRecord(COLLECTION, artifact);
  eventBus.emit("artifact.created", { artifact });
  return artifact;
}

export async function getArtifact(id: string): Promise<Artifact | null> {
  return localStore.getRecord<Artifact>(COLLECTION, id);
}

export async function listArtifactsForWorkspace(
  workspaceId: string,
  kind?: string,
): Promise<Artifact[]> {
  const all = await localStore.listRecords<Artifact>(COLLECTION);
  return all
    .filter((a) => a.workspaceId === workspaceId && (!kind || a.kind === kind))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
