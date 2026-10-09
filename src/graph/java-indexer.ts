import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import type { BatchEdge, BatchEntity } from "./types.js";

/**
 * Beyond this many classes in one decompile only the first (in path order)
 * are indexed. Every graph write rewrites the whole collection file, so an
 * unbounded index of a very large app would make every later graph call slow;
 * the cut is reported in the log rather than hidden.
 */
export const MAX_CLASSES = 20000;

const IGNORED = new Set(["package-info.java", "module-info.java"]);

/**
 * Turns decompiled source paths (relative to jadx's `sources/` directory,
 * forward slashes) into package and class entities with `contains` edges.
 *
 * - `com/acme/Login.java` -> package `com.acme`, class `com.acme.Login`
 * - a file at the top level has a class but no package and no edge
 * - only `.java` files count; `package-info` and `module-info` are skipped
 *
 * Pure: no filesystem, storage or events.
 */
export function parseJavaSources(
  files: string[],
  maxClasses = MAX_CLASSES,
): { entities: BatchEntity[]; edges: BatchEdge[]; truncated: boolean } {
  const classFiles = files.filter(
    (f) => f.endsWith(".java") && !IGNORED.has(path.posix.basename(f)),
  );
  const truncated = classFiles.length > maxClasses;
  const used = truncated ? classFiles.slice(0, maxClasses) : classFiles;

  const entities: BatchEntity[] = [];
  const edges: BatchEdge[] = [];
  const classCounts = new Map<string, number>();

  for (const file of used) {
    const withoutExt = file.slice(0, -".java".length);
    const className = withoutExt.split("/").join(".");
    const dir = path.posix.dirname(file);
    entities.push({ type: "class", name: className, attributes: { file } });

    if (dir !== ".") {
      const pkg = dir.split("/").join(".");
      classCounts.set(pkg, (classCounts.get(pkg) ?? 0) + 1);
      edges.push({
        from: { type: "package", name: pkg },
        to: { type: "class", name: className },
        relation: "contains",
      });
    }
  }

  for (const [pkg, classCount] of classCounts) {
    entities.push({ type: "package", name: pkg, attributes: { classCount } });
  }
  return { entities, edges, truncated };
}

/** Relative, forward-slash paths of every file under `root`. Symlinks are not followed. */
export async function listFiles(root: string, limit = MAX_CLASSES * 4): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length > 0 && out.length < limit) {
    const rel = stack.pop()!;
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile() && out.length < limit) out.push(child);
    }
  }
  return out.sort();
}

/** jadx writes sources under `<out>/sources`; fall back to the directory itself. */
async function sourcesRoot(dir: string): Promise<string> {
  const candidate = path.join(dir, "sources");
  try {
    if ((await stat(candidate)).isDirectory()) return candidate;
  } catch {
    // no sources/ directory - use the artifact directory as it is
  }
  return dir;
}

/** Indexes one `java-sources` directory artifact into the graph. */
export async function indexJavaArtifact(artifact: Artifact) {
  const root = await sourcesRoot(artifact.path);
  const { entities, edges, truncated } = parseJavaSources(await listFiles(root));
  if (truncated) {
    console.warn(
      `[graph-indexer] ${artifact.path}: indexing capped at the first ${MAX_CLASSES} classes`,
    );
  }
  return graphService.indexBatch({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    entities,
    edges,
  });
}

/**
 * Subscribes to recorded artifacts and indexes decompiled sources. Registered
 * once at startup (see core/server.ts), like the artifact recorder; a failure
 * is logged and never affects the task that produced the artifact.
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "java-sources" || artifact.pathType !== "directory") return;
  try {
    await indexJavaArtifact(artifact);
  } catch (err) {
    console.warn(
      `[graph-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
