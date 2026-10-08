import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import { capabilityRegistry, type CapabilityRegistry } from "../capabilities/registry.js";
import type { McpTask } from "../core/types.js";
import * as artifactService from "./artifact.service.js";
import type { ArtifactInput } from "./types.js";

/**
 * Works out which artifacts a completed task produced, from its adapter
 * descriptor and result. Pure: no storage, no events.
 *
 * The convention is deliberately narrow for now: an operation that declares
 * exactly one output kind, and whose result carries `outputPath` (a file) or
 * `outputDir` (a directory) - which is how jadx and apktool already report
 * theirs. Operations that declare no outputs, several outputs, or return
 * neither key record nothing rather than guessing a mapping.
 */
export function extractArtifacts(
  task: McpTask,
  registry: CapabilityRegistry = capabilityRegistry,
): ArtifactInput[] {
  if (task.status !== "completed") return [];

  const operation = registry
    .getAdapter(task.agent)
    ?.operations.find((op) => op.name === task.operation);
  if (!operation?.outputs || operation.outputs.length !== 1) return [];

  const result = task.result;
  if (typeof result !== "object" || result === null) return [];
  const { outputPath, outputDir } = result as { outputPath?: unknown; outputDir?: unknown };

  const [kind] = operation.outputs;
  if (!kind) return [];
  const base = {
    workspaceId: task.workspaceId,
    kind,
    source: {
      taskId: task.id,
      agent: task.agent,
      operation: task.operation,
      capability: operation.capability,
    },
  };

  if (typeof outputPath === "string" && outputPath) {
    return [{ ...base, path: outputPath, pathType: "file" }];
  }
  if (typeof outputDir === "string" && outputDir) {
    return [{ ...base, path: outputDir, pathType: "directory" }];
  }
  return [];
}

/**
 * Subscribes to finished tasks and records their artifacts. Like the
 * knowledge indexer it is never called directly: registered once at startup
 * (see core/server.ts) so the agents stay unaware of it. A failure here is
 * logged and never affects the task that produced the output.
 */
export function register() {
  eventBus.on("mcp.task.completed", onTaskCompleted);
}

async function onTaskCompleted({ task }: EventMap["mcp.task.completed"]) {
  try {
    for (const input of extractArtifacts(task)) {
      await artifactService.recordArtifact(input);
    }
  } catch (err) {
    console.warn(
      `[artifact-recorder] could not record artifacts for task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
