import { getSupabase } from "../../providers/supabase.client.js";
import * as localStore from "../../providers/local-storage.provider.js";
import type { Workflow } from "../../core/types.js";

const COLLECTION = "workflows";

function warnFallback(op: string, message: string) {
  console.warn(`[workflow.service] Supabase ${op} failed, falling back to local storage: ${message}`);
}

/**
 * Write-through persistence for a Workflow snapshot. WorkflowEngine calls
 * this fire-and-forget on every state change, mirroring job.service.ts -
 * the in-memory Map stays authoritative for the running engine, this
 * just makes the latest snapshot durable across restarts.
 */
export async function persistWorkflow(workflow: Workflow): Promise<void> {
  const supabase = getSupabase();
  if (supabase) {
    const { error } = await supabase.from("workflows").upsert(workflow);
    if (error) {
      warnFallback("upsert", error.message);
      await localStore.upsertRecord(COLLECTION, workflow);
    }
    return;
  }
  await localStore.upsertRecord(COLLECTION, workflow);
}

/**
 * Loads every persisted workflow, for WorkflowEngine.hydrate() to call
 * once at startup. A workflow left "running"/"queued" has no live Job
 * behind it after a restart - the caller marks those failed rather than
 * pretending the step sequence is still advancing.
 */
export async function listAllWorkflows(): Promise<Workflow[]> {
  const supabase = getSupabase();
  if (supabase) {
    const { data, error } = await supabase.from("workflows").select("*");
    if (!error) return data as Workflow[];
    warnFallback("select", error.message);
  }
  return localStore.listRecords<Workflow>(COLLECTION);
}
