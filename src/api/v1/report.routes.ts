import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import { buildReport } from "../../report/builder.js";
import { renderMarkdown } from "../../report/markdown.js";
import { renderSarif } from "../../report/sarif.js";
import type { FindingStatus } from "../../findings/types.js";

const statusSchema = z.enum([
  "unverified",
  "confirmed",
  "contradicted",
]) as z.ZodType<FindingStatus>;

const querySchema = z.object({
  format: z.enum(["json", "markdown", "sarif"]).default("json"),
  status: statusSchema.optional(),
  verify: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export async function reportRoutes(app: FastifyInstance) {
  // Read-only: gathers the findings and, unless verify=false, re-checks their
  // evidence against the cited files. Nothing is stored or changed.
  app.get("/workspaces/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { format, status, verify } = parsed.data;
    const report = await buildReport(workspace, { status, verify });

    if (format === "markdown") {
      return reply.type("text/markdown; charset=utf-8").send(renderMarkdown(report));
    }
    if (format === "sarif") {
      const sarif = JSON.stringify(renderSarif(report), null, 2);
      return reply.type("application/sarif+json").send(sarif);
    }
    return report;
  });
}
