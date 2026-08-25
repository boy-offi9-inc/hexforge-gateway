import { nanoid } from "nanoid";
import type { McpTask, TaskDispatchRequest, McpAgentKind } from "../../core/types.js";
import { eventBus } from "../../events/event-bus.js";
import { jadxHandler } from "./agents/jadx.agent.js";
import { apkMcpHandler } from "./agents/apkmcp.agent.js";
import { apktoolHandler } from "./agents/apktool.agent.js";
import { aiHandler } from "./agents/ai.agent.js";
import { filesystemHandler } from "./agents/filesystem.agent.js";
import { adbHandler } from "./agents/adb.agent.js";
import { fridaHandler } from "./agents/frida.agent.js";
import { apkidHandler } from "./agents/apkid.agent.js";

/**
 * McpOrchestrator dispatches tasks to registered agent handlers and tracks
 * their lifecycle. Agent handlers are pluggable - each one wraps a local tool
 * (APKTool, JADX, Frida, ADB, filesystem ops) and runs in the MCP runtime.
 *
 * Per HexForge_Architecture_v2.md, this no longer emits its own events
 * directly - it publishes to the shared Event Bus instead, so other
 * modules (WebSocket gateway, Job Engine, Knowledge Indexer) can
 * subscribe without holding a reference to the orchestrator.
 */
export type AgentHandler = (task: McpTask) => Promise<unknown>;

class McpOrchestrator {
  private tasks = new Map<string, McpTask>();
  private handlers = new Map<McpAgentKind, AgentHandler>();

  registerAgent(kind: McpAgentKind, handler: AgentHandler) {
    this.handlers.set(kind, handler);
  }

  getTask(id: string): McpTask | undefined {
    return this.tasks.get(id);
  }

  listTasksForWorkspace(workspaceId: string): McpTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.workspaceId === workspaceId);
  }

  async dispatch(req: TaskDispatchRequest): Promise<McpTask> {
    const now = new Date().toISOString();
    const task: McpTask = {
      id: nanoid(12),
      workspaceId: req.workspaceId,
      agent: req.agent,
      operation: req.operation,
      payload: req.payload ?? {},
      status: "queued",
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    eventBus.emit("mcp.task.created", { task });
    eventBus.emit("mcp.task.updated", { task });

    // Fire and forget - execution happens async, updates flow via events.
    void this.execute(task);

    return task;
  }

  private async execute(task: McpTask) {
    const handler = this.handlers.get(task.agent);
    this.updateTask(task.id, { status: "running" });

    if (!handler) {
      this.updateTask(task.id, { status: "failed", error: `No handler registered for agent "${task.agent}"` });
      return;
    }

    try {
      const result = await handler(task);
      this.updateTask(task.id, { status: "completed", result });
    } catch (err) {
      this.updateTask(task.id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private updateTask(id: string, patch: Partial<McpTask>) {
    const existing = this.tasks.get(id);
    if (!existing) return;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.tasks.set(id, updated);

    eventBus.emit("mcp.task.updated", { task: updated });
    if (updated.status === "completed") eventBus.emit("mcp.task.completed", { task: updated });
    if (updated.status === "failed") eventBus.emit("mcp.task.failed", { task: updated });
  }
}

export const orchestrator = new McpOrchestrator();

// --- Real agent handlers -------------------------------------------------
orchestrator.registerAgent("jadx", jadxHandler);
orchestrator.registerAgent("apkmcp", apkMcpHandler);
orchestrator.registerAgent("apktool", apktoolHandler);
orchestrator.registerAgent("ai", aiHandler);
orchestrator.registerAgent("filesystem", filesystemHandler);
orchestrator.registerAgent("adb", adbHandler);
orchestrator.registerAgent("frida", fridaHandler);
orchestrator.registerAgent("apkid", apkidHandler);
