import { getSupabase } from "../../providers/supabase.client.js";
import * as localStore from "../../providers/local-storage.provider.js";
import type { Job } from "../../core/types.js";

const COLLECTION = "jobs";

function warnFallback(op: string, message: string) {
  console.warn(`[job.service] Supabase ${op} failed, falling back to local storage: ${message}`);
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
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("jobs").upsert(job);
    if (error) {
      warnFallback("upsert", error.message);
      await localStore.upsertRecord(COLLECTION, job);
    }
    return;
  }
  await localStore.upsertRecord(COLLECTION, job);
}

/**
 * Loads every persisted job, for JobEngine.hydrate() to call once at
 * startup. Jobs left "running" or "queued" when the process died have no
 * in-flight McpTask to resume against (Tasks were never persisted
 * either) - the caller is expected to mark those failed rather than
 * pretend they're still progressing.
 */
export async function listAllJobs(): Promise<Job[]> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("jobs").select("*");
    if (!error) return data as Job[];
    warnFallback("select", error.message);
  }
  return localStore.listRecords<Job>(COLLECTION);
}
