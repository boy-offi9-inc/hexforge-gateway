import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { config } from "../core/config.js";

/**
 * Local file-backed persistence. Used two ways:
 *
 *  1. As the storage backend when Supabase isn't configured at all -
 *     replaces a plain in-memory Map, so workspace/knowledge data
 *     actually survives a restart instead of vanishing every time.
 *  2. As a fallback when Supabase *is* configured but a call fails at
 *     runtime (offline device, DNS failure, Supabase outage - the exact
 *     "TypeError: fetch failed" case that used to crash a request with a
 *     500 instead of degrading gracefully).
 *
 * Each "collection" (workspaces, knowledge_entries, ...) is one JSON file
 * under DATA_DIR, holding a flat `{ [id]: record }` map. Writes are
 * atomic (write to a temp file, then rename over the real one) so a
 * killed process - common on mobile/Termux - can't corrupt the file
 * mid-write.
 *
 * Intentionally simple: no indexing, no migrations, no query language.
 * This is meant to keep the Gateway working and remembering state while
 * Supabase is unreachable, not to replace it as a real database. There is
 * no reconciliation between the two - anything written to local storage
 * while Supabase was unreachable stays local-only until Supabase comes
 * back and you have to decide what to do with it (see README's Local
 * storage fallback section).
 */

const DATA_DIR = path.resolve(config.DATA_DIR);

// Fixes a real race: two concurrent upserts (or an upsert + a delete) on
// the same collection both do read -> modify -> write. Without
// serializing that, the second write can clobber the first (whichever
// finishes writing last wins, silently dropping the other's change). This
// only protects operations *within this process* - it doesn't help if two
// separate Gateway processes point at the same DATA_DIR, which isn't a
// supported setup anyway (see the module doc comment).
const collectionLocks = new Map<string, Promise<unknown>>();

function withCollectionLock<T>(collection: string, fn: () => Promise<T>): Promise<T> {
  const prior = collectionLocks.get(collection) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  // Swallow errors in the chained value we *store* (not the one we
  // return) so one failed write doesn't permanently wedge the queue for
  // every write after it.
  collectionLocks.set(collection, next.catch(() => undefined));
  return next;
}

async function ensureDataDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

function collectionPath(name: string): string {
  return path.join(DATA_DIR, `${name}.json`);
}

async function readCollection<T>(name: string): Promise<Record<string, T>> {
  await ensureDataDir();
  try {
    const raw = await readFile(collectionPath(name), "utf-8");
    return JSON.parse(raw) as Record<string, T>;
  } catch (err: any) {
    if (err?.code === "ENOENT") return {};
    throw err;
  }
}

async function writeCollection<T>(name: string, data: Record<string, T>): Promise<void> {
  await ensureDataDir();
  const finalPath = collectionPath(name);
  const tmpPath = `${finalPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, finalPath);
}

export async function getRecord<T>(collection: string, id: string): Promise<T | null> {
  const data = await readCollection<T>(collection);
  return data[id] ?? null;
}

export async function findRecord<T>(collection: string, predicate: (record: T) => boolean): Promise<T | null> {
  const data = await readCollection<T>(collection);
  return Object.values(data).find(predicate) ?? null;
}

export async function listRecords<T>(collection: string): Promise<T[]> {
  const data = await readCollection<T>(collection);
  return Object.values(data);
}

export async function upsertRecord<T extends { id: string }>(collection: string, record: T): Promise<T> {
  return withCollectionLock(collection, async () => {
    const data = await readCollection<T>(collection);
    data[record.id] = record;
    await writeCollection(collection, data);
    return record;
  });
}

export async function deleteRecord(collection: string, id: string): Promise<boolean> {
  return withCollectionLock(collection, async () => {
    const data = await readCollection(collection);
    if (!(id in data)) return false;
    delete data[id];
    await writeCollection(collection, data);
    return true;
  });
}
