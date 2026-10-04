import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import { workflowEngine } from "../../modules/workflow/workflow-engine.js";
import type { McpAgentKind } from "../../core/types.js";

const stepSchema = z.object({
  agent: z.string().min(1) as z.ZodType<McpAgentKind>,
  operation: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  mergePreviousResult: z.boolean().optional(),
});

const submitWorkflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1),
});

export async function workflowRoutes(app: FastifyInstance) {
  app.post("/workspaces/:id/workflows", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = submitWorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const workflow = workflowEngine.submit({
      workspaceId: id,
      name: parsed.data.name,
      steps: parsed.data.steps,
    });

    return reply.code(202).send(workflow);
  });

  app.get("/workspaces/:id/workflows", async (req) => {
    const { id } = req.params as { id: string };
    return workflowEngine.listWorkflowsForWorkspace(id);
  });

  app.get("/workflows/:workflowId", async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const workflow = workflowEngine.getWorkflow(workflowId);
    if (!workflow) return reply.code(404).send({ error: "Workflow not found" });
    return workflow;
  });
}
