import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import * as findingService from "../../findings/finding.service.js";
import type { FindingConfidence, FindingStatus } from "../../findings/types.js";

const statusSchema = z.enum([
  "unverified",
  "confirmed",
  "contradicted",
]) as z.ZodType<FindingStatus>;
const confidenceSchema = z.enum(["low", "medium", "high"]) as z.ZodType<FindingConfidence>;

const evidenceSchema = z.object({
  artifactId: z.string().min(1),
  entityId: z.string().min(1).optional(),
  location: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
});

const createFindingSchema = z.object({
  claim: z.string().min(1),
  status: statusSchema.optional(),
  confidence: confidenceSchema.optional(),
  reasoning: z.string().min(1).optional(),
  evidence: z.array(evidenceSchema).max(50).optional(),
  source: z.enum(["user", "ai", "system"]).optional(),
});

const updateFindingSchema = z
  .object({
    status: statusSchema.optional(),
    confidence: confidenceSchema.optional(),
    reasoning: z.string().min(1).optional(),
    evidence: z.array(evidenceSchema).max(50).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

const listQuerySchema = z.object({
  status: statusSchema.optional(),
  entityId: z.string().min(1).optional(),
});

export async function findingRoutes(app: FastifyInstance) {
  app.post("/workspaces/:id/findings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = createFindingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const finding = await findingService.createFinding({ workspaceId: id, ...parsed.data });
      return reply.code(201).send(finding);
    } catch (err) {
      if (err instanceof findingService.EvidenceError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/workspaces/:id/findings", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return findingService.listFindingsForWorkspace(id, parsed.data);
  });

  app.get("/findings/:findingId", async (req, reply) => {
    const { findingId } = req.params as { findingId: string };
    const finding = await findingService.getFinding(findingId);
    if (!finding) return reply.code(404).send({ error: "Finding not found" });
    return finding;
  });

  app.patch("/findings/:findingId", async (req, reply) => {
    const { findingId } = req.params as { findingId: string };
    const parsed = updateFindingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const finding = await findingService.updateFinding(findingId, parsed.data);
      if (!finding) return reply.code(404).send({ error: "Finding not found" });
      return finding;
    } catch (err) {
      if (err instanceof findingService.EvidenceError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });
}
