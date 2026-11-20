import { readFile } from "node:fs/promises";
import path from "node:path";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import { listFiles, MAX_CLASSES } from "./java-indexer.js";
import type { BatchEdge, BatchEntity } from "./types.js";

/**
 * Beyond this many resource files in one project only the first (in path
 * order) are indexed, mirroring the Java indexer's cap - every graph write
 * rewrites the whole collection file.
 */
export const MAX_RESOURCES = MAX_CLASSES;

/** Component tags the manifest indexer turns into class entities. */
export const COMPONENT_TAGS = ["activity", "service", "receiver", "provider"] as const;

/**
 * Turns an apktool project's decoded AndroidManifest.xml into graph
 * entities and edges:
 *
 *  - the app's `package` attribute becomes a `package` entity (the app
 *    id, e.g. `com.acme.app`, which is a namespace, not a code package)
 *  - every declared component (`activity`/`service`/`receiver`/`provider`)
 *    becomes a `class` entity (with a `component` attribute saying which
 *    tag it came from, plus `exported` when the manifest says so); a
 *    `package -> class` `contains` edge links it to the code package of
 *    its fully-qualified name, so a component that the smali/java
 *    indexers also saw is the same entity, enriched
 *  - `uses-permission` entries become `resource` entities named
 *    `permission:<name>` on the app package via an `accesses` edge,
 *    because a permission is something the app asks the platform for -
 *    not code it contains
 *  - `<intent-filter>` actions/categories become `resource` entities
 *    named `intent:<value>` with an `accesses` edge from the component
 *    that declares them, which is the cheap, high-signal half of the
 *    app's external surface (deep links, exported entry points)
 *
 * Relative component names (`.MainActivity`) are resolved against the
 * app package. Pure: no filesystem, storage or events. Regex-based
 * parsing, same as triage's manifest parsing - the decoded manifest is
 * plain XML, and a full XML parser would pull a dependency into the
 * graph for two attributes and three tag types.
 */
export function parseManifestGraph(
  manifest: string,
  maxResources = MAX_RESOURCES,
): { entities: BatchEntity[]; edges: BatchEdge[]; truncated: boolean } {
  const entities: BatchEntity[] = [];
  const edges: BatchEdge[] = [];

  const appPackage = manifest.match(/<manifest[^>]*\bpackage="([^"]+)"/)?.[1] ?? undefined;

  const resourceCount = () => entities.filter((e) => e.type === "resource").length;
  const addResource = (name: string, attributes: Record<string, string | number | boolean>) => {
    if (resourceCount() >= maxResources) return false;
    entities.push({ type: "resource", name, attributes });
    return true;
  };

  if (appPackage) {
    entities.push({ type: "package", name: appPackage, attributes: { appId: true } });
  }

  const seenComponents = new Set<string>();
  for (const tag of COMPONENT_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(manifest)) !== null) {
      const element = m[0];
      const rawName = element.match(/android:name="([^"]+)"/)?.[1];
      if (!rawName) continue;
      const cls = rawName.startsWith(".")
        ? appPackage && rawName.length > 1
          ? `${appPackage}${rawName}`
          : undefined
        : rawName.includes(".") && appPackage
          ? rawName
          : undefined;
      if (!cls || seenComponents.has(cls)) continue;
      seenComponents.add(cls);

      const attrs: Record<string, string | number | boolean> = { component: tag };
      const exported = element.match(/android:exported="([^"]+)"/)?.[1];
      if (exported !== undefined) attrs.exported = exported === "true";
      entities.push({ type: "class", name: cls, attributes: attrs });

      const pkg = cls.slice(0, cls.lastIndexOf("."));
      if (pkg) {
        edges.push({
          from: { type: "package", name: pkg },
          to: { type: "class", name: cls },
          relation: "contains",
        });
      }

      // Intent filters belong to the nearest enclosing component element.
      // The manifest nests them one level deep, so scan forward from this
      // component's start to the next component tag and collect the
      // android:name values inside any <intent-filter> in between.
      const nextTag = new RegExp(`<(${COMPONENT_TAGS.join("|")})\\b`, "g");
      nextTag.lastIndex = re.lastIndex;
      const end = nextTag.exec(manifest)?.index ?? manifest.length;
      const scope = manifest.slice(m.index, end);
      for (const intent of scope.matchAll(/<intent-filter[\s\S]*?<\/intent-filter>/g)) {
        for (const name of intent[0].matchAll(/android:name="([^"]+)"/g)) {
          const value = name[1];
          if (!value.startsWith("android.intent.") && !value.includes(".")) continue;
          const resName = `intent:${value}`;
          if (!addResource(resName, { intent: true })) break;
          edges.push({
            from: { type: "class", name: cls },
            to: { type: "resource", name: resName },
            relation: "accesses",
          });
        }
        if (resourceCount() >= maxResources) break;
      }
    }
    if (resourceCount() >= maxResources) break;
  }

  const seenPermissions = new Set<string>();
  for (const perm of manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)) {
    const name = `permission:${perm[1]}`;
    if (seenPermissions.has(name)) continue;
    seenPermissions.add(name);
    if (!addResource(name, { permission: true })) break;
    if (appPackage) {
      edges.push({
        from: { type: "package", name: appPackage },
        to: { type: "resource", name },
        relation: "accesses",
      });
    }
  }

  return { entities, edges, truncated: resourceCount() >= maxResources };
}

/**
 * Resource files the project ships: anything under `res/` or `assets/`.
 * Names are the path relative to the project (forward slashes), so
 * `res/values/strings.xml` is a `resource` entity of exactly that name,
 * with a `contains` edge from the app package when it is known.
 */
export function parseResourceFiles(
  files: string[],
  appPackage?: string,
  maxResources = MAX_RESOURCES,
): { entities: BatchEntity[]; edges: BatchEdge[]; truncated: boolean } {
  const resFiles = files.filter((f) => f.startsWith("res/") || f.startsWith("assets/"));
  const truncated = resFiles.length > maxResources;
  const entities: BatchEntity[] = [];
  const edges: BatchEdge[] = [];
  for (const file of resFiles.slice(0, maxResources)) {
    entities.push({ type: "resource", name: file, attributes: { file } });
    if (appPackage) {
      edges.push({
        from: { type: "package", name: appPackage },
        to: { type: "resource", name: file },
        relation: "contains",
      });
    }
  }
  return { entities, edges, truncated };
}

/** Reads `<project>/AndroidManifest.xml` when it is there. */
async function readManifest(dir: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(dir, "AndroidManifest.xml"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Indexes one `apktool-project` directory artifact's manifest and
 * resources into the graph, beside the smali indexer (which handles the
 * code). Returns null when there is no manifest to read - a decode with
 * `--no-src` still has one, so this only happens on a broken artifact.
 */
export async function indexManifestArtifact(artifact: Artifact) {
  const manifest = await readManifest(artifact.path);
  if (!manifest) return null;

  const parsed = parseManifestGraph(manifest);
  const appPackage = parsed.entities.find((e) => e.type === "package")?.name;
  const resources = parseResourceFiles(await listFiles(artifact.path, MAX_RESOURCES), appPackage);
  if (resources.truncated) {
    console.warn(
      `[graph-indexer] ${artifact.path}: resource indexing capped at the first ${MAX_RESOURCES} files`,
    );
  }
  return graphService.indexBatch({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    entities: [...parsed.entities, ...resources.entities],
    edges: [...parsed.edges, ...resources.edges],
  });
}

/**
 * Subscribes to recorded artifacts, beside the smali indexer; a failure
 * is logged and never affects the decode that produced the artifact.
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "apktool-project" || artifact.pathType !== "directory") return;
  try {
    await indexManifestArtifact(artifact);
  } catch (err) {
    console.warn(
      `[graph-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
