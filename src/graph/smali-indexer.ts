import { readdir } from "node:fs/promises";
import path from "node:path";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import { listFiles, MAX_CLASSES } from "./java-indexer.js";
import type { BatchEdge, BatchEntity, BatchResult } from "./types.js";

/** apktool writes `smali`, then `smali_classes2`, `smali_classes3`, ... one per dex file. */
const SMALI_DIR = /^smali(_.+)?$/;

/**
 * Turns the smali files of an apktool project into the same kind of graph as
 * the Java indexer: a `class` per file, a `package` per directory, and
 * package -> class `contains` edges. Names come from the path
 * (`smali/com/acme/Login.smali` is `com.acme.Login`), so a class that jadx also
 * decompiled is the same entity and gets enriched rather than duplicated.
 *
 * `files` are relative to the artifact directory with forward slashes, so the
 * first segment is the smali directory. The attributes use their own names
 * (`smaliFile`, `smaliClassCount`) so they sit beside the Java indexer's
 * `file` and `classCount` instead of overwriting them.
 *
 * Smali keeps an inner class in its own file (`Outer$Inner.smali`), so an
 * `Outer` -> `Outer$Inner` `contains` edge is added whenever `Outer` is there
 * too. Pure: no filesystem, storage or events.
 */
export function parseSmaliSources(
  files: string[],
  maxClasses = MAX_CLASSES,
): { entities: BatchEntity[]; edges: BatchEdge[]; truncated: boolean } {
  const classes = new Map<string, { smaliFile: string; pkg?: string }>();
  for (const file of files) {
    const [root, ...rest] = file.split("/");
    if (!root || !SMALI_DIR.test(root) || !file.endsWith(".smali") || rest.length === 0) continue;

    const classPath = rest.join("/").slice(0, -".smali".length);
    const name = classPath.split("/").join(".");
    if (classes.has(name)) continue; // the same class in two dex files: keep the first
    const dir = path.posix.dirname(rest.join("/"));
    classes.set(name, { smaliFile: file, pkg: dir === "." ? undefined : dir.split("/").join(".") });
  }

  const truncated = classes.size > maxClasses;
  const used = [...classes].slice(0, maxClasses);
  const names = new Set(used.map(([name]) => name));

  const entities: BatchEntity[] = [];
  const edges: BatchEdge[] = [];
  const packageCounts = new Map<string, number>();

  for (const [name, { smaliFile, pkg }] of used) {
    entities.push({ type: "class", name, attributes: { smaliFile } });
    if (pkg) {
      packageCounts.set(pkg, (packageCounts.get(pkg) ?? 0) + 1);
      edges.push({
        from: { type: "package", name: pkg },
        to: { type: "class", name },
        relation: "contains",
      });
    }
    const cut = name.lastIndexOf("$");
    const outer = cut > 0 ? name.slice(0, cut) : undefined;
    if (outer && names.has(outer)) {
      edges.push({
        from: { type: "class", name: outer },
        to: { type: "class", name },
        relation: "contains",
      });
    }
  }

  for (const [pkg, smaliClassCount] of packageCounts) {
    entities.push({ type: "package", name: pkg, attributes: { smaliClassCount } });
  }
  return { entities, edges, truncated };
}

/** Relative (to `dir`) forward-slash paths of every file under each smali directory. */
async function listSmaliFiles(dir: string): Promise<string[]> {
  const top = await readdir(dir, { withFileTypes: true });
  const roots = top
    .filter((e) => e.isDirectory() && SMALI_DIR.test(e.name))
    .map((e) => e.name)
    .sort();

  const out: string[] = [];
  for (const root of roots) {
    for (const file of await listFiles(path.join(dir, root))) out.push(`${root}/${file}`);
  }
  return out;
}

/**
 * Indexes one `apktool-project` directory artifact into the graph. Returns
 * null when there is nothing to index - e.g. a decode with `noSrc`, which
 * skips the smali.
 */
export async function indexSmaliArtifact(artifact: Artifact): Promise<BatchResult | null> {
  const { entities, edges, truncated } = parseSmaliSources(await listSmaliFiles(artifact.path));
  if (entities.length === 0) return null;
  if (truncated) {
    console.warn(
      `[graph-indexer] ${artifact.path}: smali indexing capped at the first ${MAX_CLASSES} classes`,
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
 * Subscribes to recorded artifacts and indexes decoded smali. Registered once
 * at startup (see core/server.ts) beside the Java indexer; a failure is
 * logged and never affects the decode that produced the artifact.
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "apktool-project" || artifact.pathType !== "directory") return;
  try {
    await indexSmaliArtifact(artifact);
  } catch (err) {
    console.warn(
      `[graph-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
