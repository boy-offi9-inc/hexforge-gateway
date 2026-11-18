import { getStorage, localStorageProvider } from "../../providers/storage.provider.js";
import type { Job } from "../../core/types.js";

const COLLECTION = "jobs";

function store() {
  return getStorage() ?? localStorageProvider();
}

/**
 * Write-through persistence for a Job snapshot. JobEngine calls this
 * fire-and-forget on every state change (submit + update) - the
 * in-memory Map in JobEngine stays the synchronous source of truth its
 * retry/event logic reads from (see job-engine.ts's "check before
 * subscribing" comment); this only makes sure the latest snapshot
 * survives a restart. A failed persist here never affects the live job -
 * worst case, that one snapshot isn't recoverable after a restart.
 */
export async function persistJob(job: Job): Promise<void> {
  await store().upsertRecord(COLLECTION, job);
}

/**
 * Loads every persisted job, for JobEngine.hydrate() to call once at
 * startup. Jobs left "running" or "queued" when the process died have no
 * in-flight McpTask to resume against (Tasks were never persisted
 * either) - the caller is expected to mark those failed rather than
 * pretend they're still progressing.
 */
export async function listAllJobs(): Promise<Job[]> {
  return store().listRecords<Job>(COLLECTION);
}
