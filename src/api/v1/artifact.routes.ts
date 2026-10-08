import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import * as artifactService from "../../artifacts/artifact.service.js";

const listQuerySchema = z.object({
  kind: z.string().min(1).optional(),
});

export async function artifactRoutes(app: FastifyInstance) {
  app.get("/workspaces/:id/artifacts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return artifactService.listArtifactsForWorkspace(id, parsed.data.kind);
  });

  app.get("/artifacts/:artifactId", async (req, reply) => {
    const { artifactId } = req.params as { artifactId: string };
    const artifact = await artifactService.getArtifact(artifactId);
    if (!artifact) return reply.code(404).send({ error: "Artifact not found" });
    return artifact;
  });
}
