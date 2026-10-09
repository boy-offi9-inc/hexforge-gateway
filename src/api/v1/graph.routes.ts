import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import * as graphService from "../../graph/graph.service.js";
import { ENTITY_TYPES, RELATIONS } from "../../graph/types.js";

const entityTypeSchema = z.enum(ENTITY_TYPES);
const relationSchema = z.enum(RELATIONS);

const upsertEntitySchema = z.object({
  type: entityTypeSchema,
  name: z.string().min(1).max(500),
  attributes: z
    .record(z.string().min(1).max(100), z.union([z.string().max(2000), z.number(), z.boolean()]))
    .refine((a) => Object.keys(a).length <= 20, { message: "At most 20 attributes" })
    .optional(),
  artifactIds: z.array(z.string().min(1)).max(50).optional(),
});

const addEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: relationSchema,
});

const listEntitiesQuerySchema = z.object({
  type: entityTypeSchema.optional(),
  q: z.string().min(1).optional(),
});

const listEdgesQuerySchema = z.object({
  entityId: z.string().min(1).optional(),
  relation: relationSchema.optional(),
});

export async function graphRoutes(app: FastifyInstance) {
  app.post("/workspaces/:id/graph/entities", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = upsertEntitySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const { entity, created } = await graphService.upsertEntity({
        workspaceId: id,
        ...parsed.data,
      });
      return reply.code(created ? 201 : 200).send(entity);
    } catch (err) {
      if (err instanceof graphService.GraphError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/workspaces/:id/graph/entities", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = listEntitiesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return graphService.listEntities(id, parsed.data);
  });

  app.get("/graph/entities/:entityId", async (req, reply) => {
    const { entityId } = req.params as { entityId: string };
    const result = await graphService.getEntityWithEdges(entityId);
    if (!result) return reply.code(404).send({ error: "Entity not found" });
    return result;
  });

  app.post("/workspaces/:id/graph/edges", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = addEdgeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    try {
      const { edge, created } = await graphService.addEdge({ workspaceId: id, ...parsed.data });
      return reply.code(created ? 201 : 200).send(edge);
    } catch (err) {
      if (err instanceof graphService.GraphError) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get("/workspaces/:id/graph/edges", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = listEdgesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    return graphService.listEdges(id, parsed.data);
  });
}
