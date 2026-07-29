import type { FastifyInstance } from "fastify";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";

/**
 * Simple broadcast WebSocket endpoint at /ws. Every connected client
 * receives task and workspace lifecycle events as they happen, via the
 * shared Event Bus rather than a direct reference to the MCP orchestrator
 * or workspace service - this module doesn't need to know anything about
 * where events originate. Later this can be scoped per-workspace (e.g.
 * /ws/workspaces/:id) once auth/session is added.
 */
export async function registerWebsocketGateway(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (connection) => {
    const onTaskUpdate = (payload: EventMap["mcp.task.updated"]) => {
      connection.socket.send(JSON.stringify({ type: "task:update", task: payload.task }));
    };
    const onJobUpdate = (payload: EventMap["job.updated"]) => {
      connection.socket.send(JSON.stringify({ type: "job:update", job: payload.job }));
    };
    const onWorkspaceStatusChanged = (payload: EventMap["workspace.status_changed"]) => {
      connection.socket.send(JSON.stringify({ type: "workspace:status_changed", workspace: payload.workspace }));
    };
    const onWorkflowUpdate = (payload: EventMap["workflow.updated"]) => {
      connection.socket.send(JSON.stringify({ type: "workflow:update", workflow: payload.workflow }));
    };
    const onKnowledgeEntryCreated = (payload: EventMap["knowledge.entry_created"]) => {
      connection.socket.send(JSON.stringify({ type: "knowledge:entry_created", entry: payload.entry }));
    };

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

    connection.socket.send(JSON.stringify({ type: "connected", message: "HexForge Gateway WS connected" }));
  });
}
