import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import type { BatchEdge, BatchEntity, BatchResult } from "./types.js";

/**
 * URL and string extraction - the last graph population slice. Walks a
 * directory artifact (a jadx decompile or an apktool project) and pulls:
 *
 * - `url` entities: http(s) URLs found in any text file, named by the URL
 *   itself, carrying the file and line they appeared in
 * - `string` entities: quoted string literals that look intentional - the
 *   app's own names, endpoints, flags, error messages - never a bare word
 *
 * Both kinds get `maps-to` edges to the `class` entity of the file they were
 * found in (apktool resources have no class, so their strings attach to the
 * package entity or nothing). The graph merge (derived ids) means the same
 * URL or literal reported by two artifacts converges on one entity.
 */

export const MAX_URL_ENTITIES = 5_000;
export const MAX_STRING_ENTITIES = 10_000;
export const MAX_STRING_EDGES = 20_000;

/** Files worth scanning: text-ish sources and resources only. */
const SCANNABLE = /\.(java|kt|smali|xml|properties|json|yml|yaml|txt|html|js|c|cpp|h|hpp)$/;

/** http(s) URLs; terminated at whitespace, quote or angle bracket. */
const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/**
 * A string literal worth remembering: at least 4 chars, contains a letter,
 * and is not just one bare word (endpoint paths, flags, messages, names).
 * Excludes URLs (those are their own entities) and trivial boilerplate.
 */
const STRING_RE = /"((?:[^"\\\n]|\\.)*)"/g;
const BARE_WORD_RE = /^[A-Za-z_$][\w$]*$/;
const BOILERPLATE = new Set([
  "utf-8",
  "utf8",
  "http://schemas.android.com/apk/res/android",
  "strict",
]);

export interface StringObservation {
  url: string;
  file: string;
  line: number;
}

/** Pure part: URL observations from one file's text. */
export function extractUrls(
  file: string,
  content: string,
  max = MAX_URL_ENTITIES,
): StringObservation[] {
  const out: StringObservation[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const matches = lines[i].match(URL_RE);
    if (!matches) continue;
    for (const url of matches) {
      // trailing sentence punctuation on prose lines isn't part of the URL
      const cleaned = url.replace(/[.,;:)\]]+$/, "");
      out.push({ url: cleaned, file, line: i + 1 });
      if (out.length >= max) break;
    }
  }
  return out;
}

/** Pure part: string-literal observations from one file's text. */
export function extractStrings(
  file: string,
  content: string,
  max = MAX_STRING_ENTITIES,
): StringObservation[] {
  const out: StringObservation[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    STRING_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = STRING_RE.exec(lines[i])) !== null && out.length < max) {
      const literal = m[1];
      if (literal.length < 4) continue;
      if (!/[A-Za-z]/.test(literal)) continue; // numbers, punctuation
      if (literal.startsWith("http")) continue; // URL's own entity
      if (BARE_WORD_RE.test(literal)) continue; // bare identifier
      if (BOILERPLATE.has(literal)) continue;
      if (literal.includes("$") && literal.length < 12) continue; // format leftovers
      out.push({ url: literal, file, line: i + 1 });
    }
  }
  return out;
}

/**
 * Pure part: entities and edges for a set of observations. A URL/string maps
 * to the class of the file it was seen in (`com/acme/Api.java` ->
 * `com.acme.Api`); files outside a class layout map to nothing.
 */
export function parseUrlsAndStrings(
  observations: StringObservation[],
  kind: "url" | "string",
): { entities: BatchEntity[]; edges: BatchEdge[] } {
  const entities = new Map<string, BatchEntity>();
  const edges: BatchEdge[] = [];
  const files = new Set(observations.map((o) => o.file));
  for (const o of observations) {
    const existing = entities.get(o.url);
    if (existing) {
      // keep first-seen attributes; the class list is the edge's job
      continue;
    }
    entities.set(o.url, {
      type: kind,
      name: o.url,
      attributes: { firstSeenIn: o.file, firstSeenLine: o.line },
    });
  }
  for (const file of files) {
    if (!file.endsWith(".java") && !file.endsWith(".kt")) continue;
    const className = file
      .replace(/\.(java|kt)$/, "")
      .split("/")
      .slice(1) // drop the source root (java/ or kotlin/)
      .join(".");
    if (!className) continue;
    for (const o of observations) {
      if (o.file !== file) continue;
      edges.push({
        from: { type: kind, name: o.url },
        to: { type: "class", name: className },
        relation: "maps-to",
      });
    }
  }
  return { entities: [...entities.values()], edges: edges.slice(0, MAX_STRING_EDGES) };
}

/** Walks a directory artifact collecting scannable text files. */
export async function listTextFiles(root: string, limit = 30_000): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= limit) return;
    const dir = rel === "" ? root : path.join(root, rel);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && SCANNABLE.test(entry.name)) {
        out.push(rel === "" ? entry.name : path.posix.join(rel, entry.name));
      } else if (entry.isDirectory()) {
        await walk(rel === "" ? entry.name : path.posix.join(rel, entry.name));
      }
      if (out.length >= limit) return;
    }
  };
  await walk("");
  return out;
}

/**
 * Indexes one directory artifact's URLs and strings into the graph.
 * Returns null when there is nothing to scan (a file artifact, or no
 * scannable files).
 */
export async function indexUrlsAndStrings(artifact: Artifact): Promise<BatchResult | null> {
  if (artifact.pathType !== "directory") return null;
  const files = await listTextFiles(artifact.path);
  if (files.length === 0) return null;

  const urlObs: StringObservation[] = [];
  const strObs: StringObservation[] = [];
  for (const file of files) {
    const content = await readFile(path.join(artifact.path, file), "utf8").catch(() => null);
    if (content === null) continue;
    urlObs.push(...extractUrls(file, content));
    strObs.push(...extractStrings(file, content));
  }

  const urls = parseUrlsAndStrings(urlObs, "url");
  const strings = parseUrlsAndStrings(strObs, "string");
  const entities = [...urls.entities, ...strings.entities];
  if (entities.length === 0) return null;

  if (urls.entities.length >= MAX_URL_ENTITIES || strings.entities.length >= MAX_STRING_ENTITIES) {
    console.warn(
      `[graph-indexer] ${artifact.path}: URL/string extraction capped (${urls.entities.length} urls, ${strings.entities.length} strings)`,
    );
  }

  // Entity batch carries the urls/strings; the `maps-to` edges end on class
  // entities owned by the java/smali indexers, which aren't in this batch -
  // indexBatch only links entities it upserts itself, so those edges go
  // through addEdge (validated against the workspace, no-op on re-run).
  const result = await graphService.indexBatch({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    entities,
    edges: [],
  });

  let createdEdges = 0;
  let existingEdges = 0;
  let skipped = 0;
  for (const edge of [...urls.edges, ...strings.edges]) {
    // both ends must exist: class entities come from the java/smali indexers,
    // which may not have run on this artifact yet - skipping keeps the
    // observation without fabricating a class; a later indexing pass closes
    // the gap
    const from = graphService.entityId(artifact.workspaceId, edge.from);
    const to = graphService.entityId(artifact.workspaceId, edge.to);
    if (!(await graphService.getEntity(from)) || !(await graphService.getEntity(to))) {
      skipped++;
      continue;
    }
    const { created } = await graphService.addEdge({
      workspaceId: artifact.workspaceId,
      from: graphService.entityId(artifact.workspaceId, edge.from),
      to: graphService.entityId(artifact.workspaceId, edge.to),
      relation: "maps-to",
    });
    if (created) createdEdges++;
    else existingEdges++;
  }
  return {
    entities: result.entities,
    edges: { created: createdEdges, existing: existingEdges + skipped },
  };
}

/**
 * Subscribes to recorded artifacts and indexes decompiles and apktool
 * projects - the same artifacts the Java and smali indexers consume, so a
 * URL found in smali and in decompiled Java converges on one entity.
 * Registered once at startup (see core/server.ts).
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (
    (artifact.kind !== "java-sources" && artifact.kind !== "apktool-project") ||
    artifact.pathType !== "directory"
  )
    return;
  try {
    await indexUrlsAndStrings(artifact);
  } catch (err) {
    console.warn(
      `[graph-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
