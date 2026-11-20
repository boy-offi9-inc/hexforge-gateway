import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import { orchestrator } from "../../modules/mcp/orchestrator.js";
import { listInboxApks } from "../../modules/inbox/inbox-watcher.js";
import type { McpAgentKind } from "../../core/types.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(1),
  targetLabel: z.string().min(1),
});

const getOrCreateWorkspaceSchema = z.object({
  targetLabel: z.string().min(1).optional(),
});

const dispatchTaskSchema = z.object({
  agent: z.string().min(1) as z.ZodType<McpAgentKind>,
  operation: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export async function workspaceRoutes(app: FastifyInstance) {
  app.post("/workspaces", async (req, reply) => {
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspace = await workspaceService.createWorkspace(
      parsed.data.name,
      parsed.data.targetLabel,
    );
    return reply.code(201).send(workspace);
  });

  app.get("/workspaces", async () => {
    return workspaceService.listWorkspaces();
  });

  app.get("/workspaces/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
    return workspace;
  });

  // Per-workspace AI provider selection: `{ "aiProvider": "groq" }` sets a
  // workspace-scoped override of the global AI_PROVIDER; `{ "aiProvider":
  // null }` clears it back to the global. Validated here so a typo is a
  // 400 now, not a failure on the first chat/summarize call.
  const aiProviderSchema = z.object({
    aiProvider: z.string().min(1).nullable(),
  });
  app.patch("/workspaces/:id/ai-provider", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = aiProviderSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const workspace = await workspaceService.setWorkspaceAiProvider(id, parsed.data.aiProvider);
      if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
      return workspace;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Idempotent get-or-create: lets a caller always refer to a stable name
  // (e.g. "myapp-analysis") instead of copying a generated id out of a
  // previous response. Safe to call every time you start a session - the
  // first call creates it, every call after just returns the same one.
  app.put("/workspaces/by-name/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const parsed = getOrCreateWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const workspace = await workspaceService.getOrCreateWorkspace(
      name,
      parsed.data.targetLabel ?? name,
    );
    return reply.code(200).send(workspace);
  });

  app.post("/workspaces/:id/tasks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = dispatchTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const task = await orchestrator.dispatch({
      workspaceId: id,
      agent: parsed.data.agent,
      operation: parsed.data.operation,
      payload: parsed.data.payload,
    });

    await workspaceService.updateWorkspaceStatus(id, "analyzing");

    return reply.code(202).send(task);
  });

  app.get("/workspaces/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return orchestrator.listTasksForWorkspace(id);
  });

  // "PC-side APK MCP" - see modules/inbox/inbox-watcher.ts. Lists
  // whatever .apk files have actually landed in this workspace's own
  // inbox/ directory (from a drop into APK_INBOX_DIR, if configured),
  // so a caller can get a real apkPath without ever typing one.
  app.get("/workspaces/:id/inbox", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });
    const apks = await listInboxApks(id);
    return { apks };
  });
}
