import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import { workflowEngine } from "../../modules/workflow/workflow-engine.js";
import type { McpAgentKind } from "../../core/types.js";

const singleStepSchema = z.object({
  agent: z.string().min(1) as z.ZodType<McpAgentKind>,
  operation: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  mergePreviousResult: z.boolean().optional(),
});

// Several steps run at once. Two or more, since one branch is just a step.
const parallelStepSchema = z.object({
  parallel: z.array(singleStepSchema).min(2).max(20),
  continueOnError: z.boolean().optional(),
});

const stepSchema = z.union([singleStepSchema, parallelStepSchema]);

const submitWorkflowSchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1),
});

export async function workflowRoutes(app: FastifyInstance) {
  app.post("/workspaces/:id/workflows", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    // A step is either one operation or a "parallel" group. Schema parsing would quietly
    // drop "parallel" from a step that also names an agent, so say so instead.
    const rawSteps = (req.body as { steps?: unknown } | null)?.steps;
    const mixed = Array.isArray(rawSteps)
      ? rawSteps.findIndex(
          (s) =>
            s && typeof s === "object" && "parallel" in s && ("agent" in s || "operation" in s),
        )
      : -1;
    if (mixed >= 0) {
      return reply.code(400).send({
        error:
          `Step ${mixed} has both "parallel" and "agent"/"operation"; ` +
          "a step is one or the other",
      });
    }

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

  // Continues a failed workflow from the first step that didn't complete (a step
  // failed, or the Gateway restarted under it). That step starts over from the
  // beginning, so check it is safe to repeat first.
  app.post("/workflows/:workflowId/resume", async (req, reply) => {
    const { workflowId } = req.params as { workflowId: string };
    const outcome = workflowEngine.resume(workflowId);
    if ("error" in outcome) {
      return outcome.error === "not_found"
        ? reply.code(404).send({ error: "Workflow not found" })
        : reply.code(409).send({ error: "Only a failed workflow can be resumed" });
    }
    return reply.code(202).send(outcome.workflow);
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
