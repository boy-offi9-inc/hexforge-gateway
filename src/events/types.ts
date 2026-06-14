import type { McpTask, Workspace, Job, Workflow, KnowledgeEntry } from "../core/types.js";

/**
 * Every event the Event Bus carries, and the payload shape for each.
 * Adding a new event = add a line here, then emit/subscribe by name
 * elsewhere with full type safety.
 */
export interface EventMap {
  "workspace.created": { workspace: Workspace };
  "workspace.status_changed": { workspace: Workspace; previousStatus: Workspace["status"] };

  "mcp.task.created": { task: McpTask };
  // Fired on every task state transition, including creation - the
  // catch-all subscribers (like the WebSocket gateway) want this one.
  "mcp.task.updated": { task: McpTask };
  "mcp.task.completed": { task: McpTask };
  "mcp.task.failed": { task: McpTask };

  "job.created": { job: Job };
  // Fired on every job state transition, including creation and each
  // retry attempt - the catch-all subscribers want this one.
  "job.updated": { job: Job };
  "job.completed": { job: Job };
  "job.failed": { job: Job };

  "workflow.created": { workflow: Workflow };
  // Fired on every workflow state transition, including creation and each
  // step advancing - the catch-all subscribers (WebSocket gateway) want
  // this one.
  "workflow.updated": { workflow: Workflow };
  "workflow.completed": { workflow: Workflow };
  "workflow.failed": { workflow: Workflow };

  "knowledge.entry_created": { entry: KnowledgeEntry };
  "knowledge.entry_updated": { entry: KnowledgeEntry };

  "plugin.loaded": { name: string };
  "plugin.failed": { name: string; error: string };
}

export type EventName = keyof EventMap;
