import { getStorage, localStorageProvider } from "../../providers/storage.provider.js";
import type { Workflow } from "../../core/types.js";

const COLLECTION = "workflows";

function store() {
  return getStorage() ?? localStorageProvider();
}

/**
 * Write-through persistence for a Workflow snapshot. WorkflowEngine calls
 * this fire-and-forget on every state change, mirroring job.service.ts -
 * the in-memory Map stays authoritative for the running engine, this
 * just makes the latest snapshot durable across restarts.
 */
export async function persistWorkflow(workflow: Workflow): Promise<void> {
  await store().upsertRecord(COLLECTION, workflow);
}

/**
 * Loads every persisted workflow, for WorkflowEngine.hydrate() to call
 * once at startup. A workflow left "running"/"queued" has no live Job
 * behind it after a restart - the caller marks those failed rather than
 * pretending the step sequence is still advancing.
 */
export async function listAllWorkflows(): Promise<Workflow[]> {
  return store().listRecords<Workflow>(COLLECTION);
}
