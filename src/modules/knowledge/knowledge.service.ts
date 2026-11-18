import { nanoid } from "nanoid";
import { getStorage, localStorageProvider } from "../../providers/storage.provider.js";
import { eventBus } from "../../events/event-bus.js";
import type {
  KnowledgeEntry,
  KnowledgeEntryInput,
  KnowledgeEntryUpdate,
} from "../../core/types.js";

const COLLECTION = "knowledge_entries";

function store() {
  return getStorage() ?? localStorageProvider();
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

  await store().upsertRecord(COLLECTION, entry);

  eventBus.emit("knowledge.entry_created", { entry });
  return entry;
}

export async function getEntry(id: string): Promise<KnowledgeEntry | null> {
  return store().getRecord<KnowledgeEntry>(COLLECTION, id);
}

export interface ListEntriesOptions {
  type?: KnowledgeEntry["type"];
}

export async function listEntriesForWorkspace(
  workspaceId: string,
  options: ListEntriesOptions = {},
): Promise<KnowledgeEntry[]> {
  const all = await store().listRecords<KnowledgeEntry>(COLLECTION);
  return all
    .filter((e) => e.workspaceId === workspaceId && (!options.type || e.type === options.type))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function updateEntry(
  id: string,
  patch: KnowledgeEntryUpdate,
): Promise<KnowledgeEntry | null> {
  const updatedAt = new Date().toISOString();

  const existing = await store().getRecord<KnowledgeEntry>(COLLECTION, id);
  const updated: KnowledgeEntry | null = existing ? { ...existing, ...patch, updatedAt } : null;

  if (updated) await store().upsertRecord(COLLECTION, updated);

  if (updated) eventBus.emit("knowledge.entry_updated", { entry: updated });
  return updated;
}

export async function deleteEntry(id: string): Promise<boolean> {
  return store().deleteRecord(COLLECTION, id);
}
