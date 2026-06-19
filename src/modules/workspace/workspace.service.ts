import { nanoid } from "nanoid";
import { getSupabase } from "../../providers/supabase.client.js";
import * as localStore from "../../providers/local-storage.provider.js";
import { eventBus } from "../../events/event-bus.js";
import type { Workspace, WorkspaceStatus } from "../../core/types.js";

const COLLECTION = "workspaces";

function warnFallback(op: string, message: string) {
  console.warn(`[workspace.service] Supabase ${op} failed, falling back to local storage: ${message}`);
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

  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("workspaces").insert(workspace);
    if (error) {
      warnFallback("insert", error.message);
      await localStore.upsertRecord(COLLECTION, workspace);
    }
  } else {
    await localStore.upsertRecord(COLLECTION, workspace);
  }

  eventBus.emit("workspace.created", { workspace });
  return workspace;
}

export async function getWorkspace(id: string): Promise<Workspace | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("workspaces").select("*").eq("id", id).single();
    if (!error) return data as Workspace;
    warnFallback("select", error.message);
  }
  return localStore.getRecord<Workspace>(COLLECTION, id);
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("workspaces").select("*").order("createdAt", { ascending: false });
    if (!error) return data as Workspace[];
    warnFallback("query", error.message);
  }
  const local = await localStore.listRecords<Workspace>(COLLECTION);
  return local.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getWorkspaceByName(name: string): Promise<Workspace | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("workspaces").select("*").eq("name", name).maybeSingle();
    if (!error) return (data as Workspace | null) ?? null;
    warnFallback("select", error.message);
  }
  return localStore.findRecord<Workspace>(COLLECTION, (w) => w.name === name);
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

export async function updateWorkspaceStatus(id: string, status: WorkspaceStatus): Promise<Workspace | null> {
  const supabase = getSupabase();
  const updatedAt = new Date().toISOString();

  const previous = await getWorkspace(id);
  if (!previous) return null;
  const previousStatus = previous.status;

  let updated: Workspace | null = null;

  if (supabase) {
    const { data, error } = await supabase
      .from("workspaces")
      .update({ status, updatedAt })
      .eq("id", id)
      .select()
      .single();
    if (!error) {
      updated = data as Workspace;
    } else {
      warnFallback("update", error.message);
    }
  }

  if (!updated) {
    updated = { ...previous, status, updatedAt };
    await localStore.upsertRecord(COLLECTION, updated);
  }

  if (updated.status !== previousStatus) {
    eventBus.emit("workspace.status_changed", { workspace: updated, previousStatus });
  }

  return updated;
}
