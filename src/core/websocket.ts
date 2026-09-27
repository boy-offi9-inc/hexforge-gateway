import type { FastifyInstance } from "fastify";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";

/**
 * Two WebSocket endpoints, both fed by the shared Event Bus rather than a
 * direct reference to the MCP orchestrator or workspace service - this
 * module doesn't need to know anything about where events originate:
 *
 *  - `/ws` - unscoped firehose, unchanged from before. Every connected
 *    client receives every workspace's events. Useful for a
 *    single-workspace CLI session or a dashboard that genuinely wants
 *    everything, but doesn't scale to a multi-workspace UI where each
 *    open workspace would otherwise have to filter out every other
 *    workspace's traffic client-side.
 *  - `/ws/workspaces/:id` - scoped to one workspace. Same event types,
 *    same message shapes, but only events whose `workspaceId` matches
 *    `:id` are sent. This is the seam the web interface roadmap item
 *    will actually connect to.
 *
 * Both share the same subscribe/dispatch/cleanup logic below, filtered by
 * an optional workspaceId.
 */

type SubscribableEvent =
  | "mcp.task.updated"
  | "job.updated"
  | "workspace.status_changed"
  | "workflow.updated"
  | "knowledge.entry_created";

// How to pull the owning workspaceId out of each event's payload, so the
// scoped endpoint can decide whether to forward it. workspace.status_changed
// carries the workspace's own id under `workspace.id` rather than a
// `workspaceId` field - every other event's record already has one.
function workspaceIdOf<K extends SubscribableEvent>(event: K, payload: EventMap[K]): string {
  switch (event) {
    case "mcp.task.updated":
      return (payload as EventMap["mcp.task.updated"]).task.workspaceId;
    case "job.updated":
      return (payload as EventMap["job.updated"]).job.workspaceId;
    case "workflow.updated":
      return (payload as EventMap["workflow.updated"]).workflow.workspaceId;
    case "knowledge.entry_created":
      return (payload as EventMap["knowledge.entry_created"]).entry.workspaceId;
    case "workspace.status_changed":
      return (payload as EventMap["workspace.status_changed"]).workspace.id;
  }
}

/**
 * Wires one WebSocket connection up to the Event Bus. `scopeToWorkspaceId`
 * of `undefined` means unscoped (the `/ws` firehose behavior); otherwise
 * only events belonging to that workspace are forwarded.
 */
interface WsConnection {
  socket: {
    send: (data: string) => void;
    on: (event: "close", listener: () => void) => void;
  };
}

function attachConnection(connection: WsConnection, scopeToWorkspaceId?: string) {
  const send = (message: Record<string, unknown>) => connection.socket.send(JSON.stringify(message));

  function forwardIfInScope<K extends SubscribableEvent>(
    event: K,
    type: string,
    payload: EventMap[K],
    extract: (p: EventMap[K]) => Record<string, unknown>
  ) {
    if (scopeToWorkspaceId && workspaceIdOf(event, payload) !== scopeToWorkspaceId) return;
    send({ type, ...extract(payload) });
  }

  const onTaskUpdate = (payload: EventMap["mcp.task.updated"]) =>
    forwardIfInScope("mcp.task.updated", "task:update", payload, (p) => ({ task: p.task }));
  const onJobUpdate = (payload: EventMap["job.updated"]) =>
    forwardIfInScope("job.updated", "job:update", payload, (p) => ({ job: p.job }));
  const onWorkspaceStatusChanged = (payload: EventMap["workspace.status_changed"]) =>
    forwardIfInScope("workspace.status_changed", "workspace:status_changed", payload, (p) => ({
      workspace: p.workspace,
    }));
  const onWorkflowUpdate = (payload: EventMap["workflow.updated"]) =>
    forwardIfInScope("workflow.updated", "workflow:update", payload, (p) => ({ workflow: p.workflow }));
  const onKnowledgeEntryCreated = (payload: EventMap["knowledge.entry_created"]) =>
    forwardIfInScope("knowledge.entry_created", "knowledge:entry_created", payload, (p) => ({ entry: p.entry }));

  eventBus.on("mcp.task.updated", onTaskUpdate);
  eventBus.on("job.updated", onJobUpdate);
  eventBus.on("workspace.status_changed", onWorkspaceStatusChanged);
  eventBus.on("workflow.updated", onWorkflowUpdate);
  eventBus.on("knowledge.entry_created", onKnowledgeEntryCreated);

  connection.socket.on("close", () => {
    eventBus.off("mcp.task.updated", onTaskUpdate);
    eventBus.off("job.updated", onJobUpdate);
    eventBus.off("workspace.status_changed", onWorkspaceStatusChanged);
    eventBus.off("workflow.updated", onWorkflowUpdate);
    eventBus.off("knowledge.entry_created", onKnowledgeEntryCreated);
  });

  send({
    type: "connected",
    message: scopeToWorkspaceId
      ? `HexForge Gateway WS connected (scoped to workspace ${scopeToWorkspaceId})`
      : "HexForge Gateway WS connected",
  });
}

export async function registerWebsocketGateway(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (connection) => {
    attachConnection(connection);
  });

  app.get("/ws/workspaces/:id", { websocket: true }, (connection, req) => {
    const { id } = req.params as { id: string };
    attachConnection(connection, id);
  });
}
