import { eventBus } from "../../events/event-bus.js";
import type { EventMap } from "../../events/types.js";
import * as knowledgeService from "./knowledge.service.js";

/**
 * KnowledgeIndexer implements the "results are indexed, Knowledge Engine
 * updates memory" step of the data flow.
 *
 * It never gets called directly - it subscribes to the Event Bus and
 * reacts to `workflow.completed` / `workflow.failed`, turning each
 * finished workflow run into a "report" KnowledgeEntry automatically. That
 * keeps the Workflow Engine decoupled from the Knowledge Engine, matching
 * the architecture doc's "Modules communicate through events rather than
 * direct calls" principle - the same reason the WebSocket gateway and Job
 * Engine don't hold direct references to the modules they react to.
 *
 * This is intentionally simple for now: one entry per workflow run, with a
 * plain-text summary of each step. Once the AI provider layer exists, it
 * can subscribe to the same `workflow.completed` event to generate a
 * richer AI summary and an embedding, then call
 * knowledgeService.updateEntry() to attach them to the report this
 * indexer already created (via `sourceId` = workflowId to find it).
 *
 * register() is called once at startup (see core/server.ts) rather than
 * having this module self-register as an import side effect, so it's
 * obvious from server.ts which background listeners are active.
 */
export function register() {
  eventBus.on("workflow.completed", onWorkflowSettled);
  eventBus.on("workflow.failed", onWorkflowSettled);
}

async function onWorkflowSettled(payload: EventMap["workflow.completed"] | EventMap["workflow.failed"]) {
  const { workflow } = payload;

  const stepLines = workflow.steps.map((step, i) => {
    const outcome = step.status === "completed" ? "OK" : step.status === "failed" ? `FAILED (${step.error})` : step.status;
    return `${i + 1}. [${step.agent}:${step.operation}] ${outcome}`;
  });

  const content = [
    `Workflow "${workflow.name}" ${workflow.status}.`,
    workflow.error ? `Error: ${workflow.error}` : undefined,
    "",
    "Steps:",
    ...stepLines,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");

  try {
    await knowledgeService.createEntry({
      workspaceId: workflow.workspaceId,
      type: "report",
      title: `${workflow.name} - ${workflow.status}`,
      content,
      source: "workflow",
      sourceId: workflow.id,
    });
  } catch (err) {
    // Indexing must never crash the process or take down the workflow
    // that triggered it - the workflow itself already completed/failed
    // and that result stands regardless of whether indexing succeeds.
    console.error(`[knowledge-indexer] failed to index workflow ${workflow.id}:`, err);
  }
}
