import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import { jobEngine } from "../../modules/jobs/job-engine.js";
import type { McpAgentKind } from "../../core/types.js";

const submitJobSchema = z.object({
  agent: z.string().min(1) as z.ZodType<McpAgentKind>,
  operation: z.string().min(1),
  payload: z.record(z.unknown()).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export async function jobRoutes(app: FastifyInstance) {
  app.post("/workspaces/:id/jobs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = submitJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const job = jobEngine.submit({
      workspaceId: id,
      agent: parsed.data.agent,
      operation: parsed.data.operation,
      payload: parsed.data.payload,
      maxAttempts: parsed.data.maxAttempts,
    });

    return reply.code(202).send(job);
  });

  app.get("/workspaces/:id/jobs", async (req) => {
    const { id } = req.params as { id: string };
    return jobEngine.listJobsForWorkspace(id);
  });

  app.get("/jobs/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = jobEngine.getJob(jobId);
    if (!job) return reply.code(404).send({ error: "Job not found" });
    return job;
  });
}
