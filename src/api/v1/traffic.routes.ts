import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import * as workspaceService from "../../modules/workspace/workspace.service.js";
import * as artifactService from "../../artifacts/artifact.service.js";
import { parseCapture, looksLikeHar } from "../../graph/traffic-indexer.js";
import { resolveWithin, sanitizeWorkspaceId } from "../../utils/path-guard.js";
import { config } from "../../core/config.js";

/**
 * The traffic-capture producer (private roadmap 4A): records a capture file
 * - JSONL events or a HAR document, exported from mitmproxy/mitmweb, a
 * device-side collector, or pasted by hand - as a `traffic-capture`
 * artifact. Recording it is all the producer does; the graph indexer
 * (graph/traffic-indexer.ts) is event-driven like every other indexer and
 * turns the artifact into entities on its own.
 *
 * The content is parsed before anything is written: a file with no parsable
 * events is refused rather than recorded as an empty artifact. The stored
 * file is the capture as received - redaction happens downstream in the
 * indexer's entities, never in the evidence file.
 */

const captureBodySchema = z.object({
  content: z.string().min(1).max(5 * 1024 * 1024),
  source: z.string().min(1).max(200).optional(),
});

export async function trafficRoutes(app: FastifyInstance) {
  // the route's body limit sits just above the zod cap so the schema's
  // 5 MB boundary is what rejects oversized captures, not Fastify's default
  const captureOpts = { bodyLimit: 6 * 1024 * 1024 };
  app.post("/workspaces/:id/traffic-captures", captureOpts, async (req, reply) => {
    const { id } = req.params as { id: string };
    // id shape first: a malformed id is a 400, never a path-building input.
    // resolveWithin is the containment check every WORKSPACES_ROOT writer
    // shares - a capture file can only ever land inside its own workspace.
    try {
      sanitizeWorkspaceId(id);
    } catch {
      return reply.code(400).send({ error: "Invalid workspace id" });
    }
    const workspace = await workspaceService.getWorkspace(id);
    if (!workspace) return reply.code(404).send({ error: "Workspace not found" });

    const parsed = captureBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.flatten() });
    }
    const { content, source } = parsed.data;

    const { events, truncated } = parseCapture(content);
    if (events.length === 0) {
      return reply.code(400).send({
        error: "No parsable traffic events in the capture - expected JSONL events ({ method, url, ... }) or a HAR document",
      });
    }

    // the same sniff that decides which parser the indexer will run decides
    // the stored extension - they can never disagree
    const isHar = looksLikeHar(content);
    let file: string;
    try {
      file = resolveWithin(
        config.WORKSPACES_ROOT,
        id,
        "traffic",
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}${
          isHar ? ".har" : ".jsonl"
        }`,
      );
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content, "utf8");
    } catch (err) {
      req.log.error(err, "could not write traffic capture");
      return reply.code(500).send({ error: "Could not write the capture file" });
    }

    const artifact = await artifactService.recordArtifact({
      workspaceId: id,
      kind: "traffic-capture",
      path: file,
      pathType: "file",
      source: {
        taskId: `traffic-import-${randomBytes(4).toString("hex")}`,
        agent: "traffic",
        operation: "capture.import",
        capability: "traffic.import",
        ...(source ? { note: source } : {}),
      },
    });

    // the indexer answers asynchronously via artifact.created; this response
    // reports what the capture held, not what the graph did with it
    return reply.code(201).send({
      artifactId: artifact.id,
      path: artifact.path,
      events: events.length,
      truncated,
    });
  });
}
