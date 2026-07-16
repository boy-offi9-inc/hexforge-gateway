import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import * as knowledgeService from "../../modules/knowledge/knowledge.service.js";
import * as aiService from "../../modules/ai/ai.service.js";
import { config } from "../../core/config.js";
import type { KnowledgeEntryType } from "../../core/types.js";

const entryTypeSchema = z.enum(["chat", "note", "report", "summary"]) as z.ZodType<KnowledgeEntryType>;

const createEntrySchema = z.object({
  type: entryTypeSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  relatedEntryIds: z.array(z.string()).optional(),
});

const updateEntrySchema = z
  .object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    relatedEntryIds: z.array(z.string()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "At least one field must be provided" });

const listQuerySchema = z.object({
  type: entryTypeSchema.optional(),
});

const chatMessageSchema = z.object({
  message: z.string().min(1),
});

export async function knowledgeRoutes(app: FastifyInstance) {
  app.post("/workspaces/:id/knowledge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = createEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const entry = await knowledgeService.createEntry({
      workspaceId: id,
      type: parsed.data.type,
      title: parsed.data.title,
      content: parsed.data.content,
      relatedEntryIds: parsed.data.relatedEntryIds,
      source: "user",
    });

    return reply.code(201).send(entry);
  });

  app.get("/workspaces/:id/knowledge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsedQuery = listQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: parsedQuery.error.flatten() });
    }

    return knowledgeService.listEntriesForWorkspace(id, { type: parsedQuery.data.type });
  });

  app.get("/knowledge/:entryId", async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const entry = await knowledgeService.getEntry(entryId);
    if (!entry) return reply.code(404).send({ error: "Knowledge entry not found" });
    return entry;
  });

  app.patch("/knowledge/:entryId", async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const existing = await knowledgeService.getEntry(entryId);
    if (!existing) return reply.code(404).send({ error: "Knowledge entry not found" });

    const parsed = updateEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    const entry = await knowledgeService.updateEntry(entryId, parsed.data);
    return entry;
  });

  app.post("/knowledge/:entryId/summarize", async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const existing = await knowledgeService.getEntry(entryId);
    if (!existing) return reply.code(404).send({ error: "Knowledge entry not found" });

    if (!aiService.isAiConfigured) {
      return reply.code(503).send({
        error: `AI provider "${config.AI_PROVIDER}" is not configured (missing its API key in .env)`,
      });
    }

    try {
      const summary = await aiService.summarizeEntry(entryId);
      return reply.code(201).send(summary);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/knowledge/:entryId", async (req, reply) => {
    const { entryId } = req.params as { entryId: string };
    const existing = await knowledgeService.getEntry(entryId);
    if (!existing) return reply.code(404).send({ error: "Knowledge entry not found" });

    await knowledgeService.deleteEntry(entryId);
    return reply.code(204).send();
  });

  app.post("/workspaces/:id/chat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    if (!aiService.isAiConfigured) {
      return reply.code(503).send({
        error: `AI provider "${config.AI_PROVIDER}" is not configured (missing its API key in .env)`,
      });
    }

    const parsed = chatMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }

    try {
      const result = await aiService.chat(id, parsed.data.message);
      return reply.code(201).send(result);
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/workspaces/:id/chat", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const entries = await knowledgeService.listEntriesForWorkspace(id, { type: "chat" });
    // listEntriesForWorkspace is newest-first; a transcript reads naturally oldest-first.
    const transcript = entries
      .slice()
      .reverse()
      .map((e) => ({ role: e.source === "user" ? "user" : "assistant", content: e.content, createdAt: e.createdAt }));

    return transcript;
  });
}
