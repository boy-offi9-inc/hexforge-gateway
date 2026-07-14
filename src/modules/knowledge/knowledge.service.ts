import { nanoid } from "nanoid";
import { getSupabase } from "../../providers/supabase.client.js";
import * as localStore from "../../providers/local-storage.provider.js";
import { eventBus } from "../../events/event-bus.js";
import type { KnowledgeEntry, KnowledgeEntryInput, KnowledgeEntryUpdate } from "../../core/types.js";

const COLLECTION = "knowledge_entries";

function warnFallback(op: string, message: string) {
  console.warn(`[knowledge.service] Supabase ${op} failed, falling back to local storage: ${message}`);
}

export async function createEntry(input: KnowledgeEntryInput): Promise<KnowledgeEntry> {
  const now = new Date().toISOString();
  const entry: KnowledgeEntry = {
    id: nanoid(12),
    workspaceId: input.workspaceId,
    type: input.type,
    title: input.title,
    content: input.content,
    source: input.source ?? "user",
    sourceId: input.sourceId,
    relatedEntryIds: input.relatedEntryIds ?? [],
    createdAt: now,
    updatedAt: now,
  };

  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("knowledge_entries").insert(entry);
    if (error) {
      warnFallback("insert", error.message);
      await localStore.upsertRecord(COLLECTION, entry);
    }
  } else {
    await localStore.upsertRecord(COLLECTION, entry);
  }

  eventBus.emit("knowledge.entry_created", { entry });
  return entry;
}

export async function getEntry(id: string): Promise<KnowledgeEntry | null> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("knowledge_entries").select("*").eq("id", id).single();
    if (!error) return data as KnowledgeEntry;
    warnFallback("select", error.message);
  }
  return localStore.getRecord<KnowledgeEntry>(COLLECTION, id);
}

export interface ListEntriesOptions {
  type?: KnowledgeEntry["type"];
}

export async function listEntriesForWorkspace(
  workspaceId: string,
  options: ListEntriesOptions = {}
): Promise<KnowledgeEntry[]> {
  const supabase = getSupabase();
  if (supabase) {
    let query = supabase.from("knowledge_entries").select("*").eq("workspaceId", workspaceId);
    if (options.type) query = query.eq("type", options.type);
    const { data, error } = await query.order("createdAt", { ascending: false });
    if (!error) return data as KnowledgeEntry[];
    warnFallback("query", error.message);
  }
  const local = await localStore.listRecords<KnowledgeEntry>(COLLECTION);
  return local
    .filter((e) => e.workspaceId === workspaceId && (!options.type || e.type === options.type))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function updateEntry(id: string, patch: KnowledgeEntryUpdate): Promise<KnowledgeEntry | null> {
  const supabase = getSupabase();
  const updatedAt = new Date().toISOString();

  let updated: KnowledgeEntry | null = null;

  if (supabase) {
    const { data, error } = await supabase
      .from("knowledge_entries")
      .update({ ...patch, updatedAt })
      .eq("id", id)
      .select()
      .single();
    if (!error) {
      updated = data as KnowledgeEntry;
    } else {
      warnFallback("update", error.message);
    }
  }

  if (!updated) {
    const existing = await localStore.getRecord<KnowledgeEntry>(COLLECTION, id);
    if (existing) {
      updated = { ...existing, ...patch, updatedAt };
      await localStore.upsertRecord(COLLECTION, updated);
    }
  }

  if (updated) eventBus.emit("knowledge.entry_updated", { entry: updated });
  return updated;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("knowledge_entries").delete().eq("id", id);
    if (!error) return true;
    warnFallback("delete", error.message);
  }
  return localStore.deleteRecord(COLLECTION, id);
}
