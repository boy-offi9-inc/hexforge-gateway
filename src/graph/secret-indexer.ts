import { readFile } from "node:fs/promises";
import path from "node:path";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import * as graphService from "./graph.service.js";
import { detect } from "../modules/mcp/agents/secret-detectors.js";
import type { SecretCandidate } from "../modules/mcp/agents/secret-detectors.js";

/**
 * Turns `secret-scan` artifacts into secret-candidate entities in the
 * knowledge graph, following the same event-driven pattern as
 * java-indexer/smali-indexer: it subscribes to recorded artifacts and never
 * runs on its own. Registered once at startup (see core/server.ts); a
 * failure is logged and never affects the task that produced the artifact.
 *
 * Candidates are stored redacted: name is detector:path:line, the attributes
 * carry the fingerprint, preview, length, confidence and signals - never the
 * matched secret text. The scan's saved artifact JSON also only holds
 * redacted candidates, so no secret value is persisted anywhere.
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "secret-scan" || artifact.pathType !== "file") return;
  try {
    await indexSecretScan(artifact);
  } catch (err) {
    console.warn(
      `[secret-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function indexSecretScan(artifact: EventMap["artifact.created"]["artifact"]) {
  const scan = JSON.parse(await readFile(artifact.path, "utf8")) as {
    candidates?: SecretCandidate[];
  };
  const candidates = scan.candidates ?? [];
  if (candidates.length === 0) return;

  const entities = candidates.map((c) => ({
    type: "secret-candidate" as const,
    name: `${c.detector}:${c.file}:${c.line}`,
    attributes: {
      detector: c.detector,
      fingerprint: c.fingerprint,
      preview: c.preview,
      length: c.length,
      confidence: c.confidence,
      signals: c.signals.join("; "),
    },
  }));
  const result = await graphService.indexBatch({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    entities,
    edges: [],
  });
  console.log(
    `[secret-indexer] ${path.basename(artifact.path)}: ${result.entities.created} new secret-candidate entit${result.entities.created === 1 ? "y" : "ies"} (${candidates.length} candidates)`,
  );
}
