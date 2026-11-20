import { nanoid } from "nanoid";
import { getStorage, localStorageProvider } from "../../providers/storage.provider.js";
import { eventBus } from "../../events/event-bus.js";
import { BUILTIN_AI_PROVIDERS, customAiProviders } from "../../core/config.js";
import type { Workspace, WorkspaceStatus } from "../../core/types.js";

const COLLECTION = "workspaces";

function store() {
  return getStorage() ?? localStorageProvider();
}

export async function createWorkspace(name: string, targetLabel: string): Promise<Workspace> {
  const now = new Date().toISOString();
  const workspace: Workspace = {
    id: nanoid(12),
    name,
    targetLabel,
    status: "created",
    createdAt: now,
    updatedAt: now,
  };

  await store().upsertRecord(COLLECTION, workspace);

  eventBus.emit("workspace.created", { workspace });
  return workspace;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  return store().getRecord<Workspace>(COLLECTION, id);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const all = await store().listRecords<Workspace>(COLLECTION);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getWorkspaceByName(name: string): Promise<Workspace | null> {
  return store().findRecord<Workspace>(COLLECTION, (w) => w.name === name);
}

/**
 * Returns the existing workspace with this name, or creates one if none
 * exists yet - lets a caller always refer to a stable name (e.g. "clite-
 * analysis") instead of having to copy a generated id out of a previous
 * response. `targetLabel` is only used if a new workspace is actually
 * created; it's ignored on an existing match.
 */
export async function getOrCreateWorkspace(name: string, targetLabel: string): Promise<Workspace> {
  const existing = await getWorkspaceByName(name);
  if (existing) return existing;
  return createWorkspace(name, targetLabel);
}

export async function updateWorkspaceStatus(
  id: string,
  status: WorkspaceStatus,
): Promise<Workspace | null> {
  const updatedAt = new Date().toISOString();

  const previous = await getWorkspace(id);
  if (!previous) return null;
  const previousStatus = previous.status;

  const updated: Workspace = { ...previous, status, updatedAt };
  await store().upsertRecord(COLLECTION, updated);

  if (updated.status !== previousStatus) {
    eventBus.emit("workspace.status_changed", {
      workspace: updated,
      previousStatus,
    });
  }

  return updated;
}

/**
 * Sets (or clears, with `null`) a workspace's AI provider override. The
 * name is validated here against the same set `ai.provider.ts` dispatches
 * on - a bad name is a 400, not a surprise at the first chat call. The
 * override is stored on the workspace record itself, so it survives
 * restarts and applies to every AI call scoped to this workspace (chat,
 * summarize, the ai agent) until changed.
 */
export async function setWorkspaceAiProvider(
  id: string,
  provider: string | null,
): Promise<Workspace | null> {
  const previous = await getWorkspace(id);
  if (!previous) return null;

  if (provider !== null) {
    const available = availableAiProviders();
    if (!available.has(provider)) {
      const names = [...available].sort();
      throw new Error(`Unknown AI provider "${provider}". Available: ${names.join(", ")}.`);
    }
  }

  const updated: Workspace = {
    ...previous,
    aiProvider: provider ?? undefined,
    updatedAt: new Date().toISOString(),
  };
  await store().upsertRecord(COLLECTION, updated);
  return updated;
}

/** Every provider name the AI layer can dispatch on right now. */
export function availableAiProviders(): Set<string> {
  return new Set([...BUILTIN_AI_PROVIDERS, ...customAiProviders.map((entry) => entry.name)]);
}
