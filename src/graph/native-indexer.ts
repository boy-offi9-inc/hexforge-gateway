import { readFile } from "node:fs/promises";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import type { BatchEntity, BatchEdge, BatchResult } from "./types.js";

/**
 * JNI correlation: turns a `native-analysis` artifact (the ghidra agent's
 * JSON report) into `native-function` entities, then links each one to the
 * Java `method` entity it implements when the names line up under the JNI
 * naming rule - `Java_com_acme_Foo_bar` implements `com.acme.Foo.bar(...)`.
 *
 * The Java side comes from the calls indexer, which flags `native: true` on
 * declared methods; the graph merge (derived ids, `artifactIds` union) makes
 * re-analysis and re-decompiles converge on the same entities.
 *
 * Overloads share one exported symbol, so the match is by prefix: the edge
 * points at the shortest matching signature (`com.acme.Foo.bar`) and every
 * overload with the same parameter-less prefix also gets the edge - a native
 * method is implemented by the same symbol regardless of its parameter list.
 */

/** Cap on native-function entities per report (large stripped binaries). */
export const MAX_NATIVE_FUNCTIONS = 20_000;

/** Shape of the ghidra agent's report (scripts/ghidra/hexforge_dump.java). */
export interface GhidraReportFunctions {
  program?: string;
  functions?: { name?: string; address?: string; size?: number }[];
}

/**
 * The Java method prefixes one JNI symbol implements:
 * `Java_com_acme_Foo_bar` -> `com.acme.Foo.bar`. Underscores in package or
 * class names become `_1` in JNI encoding, so a component never splits on
 * one; component boundaries are the unescaped underscores.
 */
export function jniSymbolToJavaPrefixes(symbol: string): string[] {
  let rest = symbol;
  // long form: Java_<class>_<method>__<signature>; the signature never helps
  const overload = rest.indexOf("__");
  if (overload !== -1) rest = rest.slice(0, overload);
  if (!rest.startsWith("Java_")) return [];
  rest = rest.slice("Java_".length);
  // the method name is everything after the last UNESCAPED underscore
  // (escaped `_1` components never split)
  // split only on unescaped underscores: `_1`-style escapes stay inside
  // their component (JNI encoding: _1 is `_`, so it never marks a boundary)
  const parts = rest.split(/_(?![0-9])/);
  if (parts.length < 2) return [];
  const methodName = parts.pop()!;
  const className = parts.map(unescapeComponent).join(".");
  if (!className || !methodName) return [];
  return [`${className}.${unescapeComponent(methodName)}`];
}

/** JNI escaped identifier: `_1` is `_`, `_2` is `;`, `_3` is `[`. */
function unescapeComponent(part: string): string {
  return part.replace(
    /_([123])/g,
    (_, digit: "1" | "2" | "3") => ({ 1: "_", 2: ";", 3: "[" })[digit],
  );
}

/**
 * Pure part: native-function entities for one report. `Java_...` symbols and
 * non-JNI functions alike become entities - every function the binary
 * exports matters, JNI or not.
 */
export function parseNativeFunctions(
  report: GhidraReportFunctions,
  maxFunctions = MAX_NATIVE_FUNCTIONS,
): { entities: BatchEntity[]; truncated: boolean } {
  const entities: BatchEntity[] = [];
  const seen = new Set<string>();
  for (const fn of report.functions ?? []) {
    if (!fn?.name || entities.length >= maxFunctions) break;
    if (seen.has(fn.name)) continue;
    seen.add(fn.name);
    const attributes: BatchEntity["attributes"] = {};
    if (fn.address) attributes.address = fn.address;
    if (typeof fn.size === "number") attributes.size = fn.size;
    entities.push({ type: "native-function", name: fn.name, attributes });
  }
  return { entities, truncated: (report.functions?.length ?? 0) > maxFunctions };
}

/**
 * Pure part: JNI correlation edges. Only symbols following the JNI naming
 * rule produce edges, and only when a matching `native` method entity exists
 * (or will exist in the same batch - the graph merge resolves by name).
 */
export function jniEdges(
  functionNames: string[],
  nativeMethods: { name: string }[],
  maxEdges = 10_000,
): BatchEdge[] {
  const edges: BatchEdge[] = [];
  const native = new Set(nativeMethods.map((m) => m.name));
  for (const symbol of functionNames) {
    if (edges.length >= maxEdges) break;
    for (const prefix of jniSymbolToJavaPrefixes(symbol)) {
      // shortest prefix first: `com.acme.Foo.bar` matches `com.acme.Foo.bar(int)` too
      for (const method of native) {
        if (method === prefix || method.startsWith(`${prefix}(`)) {
          edges.push({
            from: { type: "native-function", name: symbol },
            to: { type: "method", name: method },
            relation: "maps-to",
          });
          if (edges.length >= maxEdges) break;
        }
      }
    }
  }
  return edges;
}

/**
 * Indexes one `native-analysis` file artifact: native-function entities plus
 * JNI `maps-to` edges against the workspace's `native` methods. Returns null
 * for a report with no functions.
 */
export async function indexNativeArtifact(artifact: Artifact): Promise<BatchResult | null> {
  const raw = await readFile(artifact.path, "utf8");
  const report = JSON.parse(raw) as GhidraReportFunctions;
  const { entities, truncated } = parseNativeFunctions(report);
  if (entities.length === 0) return null;
  if (truncated) {
    console.warn(
      `[graph-indexer] ${artifact.path}: native-function indexing capped at the first ${MAX_NATIVE_FUNCTIONS} functions`,
    );
  }

  const methods = await graphService.listEntities(artifact.workspaceId, { type: "method" });
  const nativeMethods = methods.filter((m) => m.attributes.native === true);
  const edges = jniEdges(
    entities.map((e) => e.name),
    nativeMethods,
  );

  const result = await graphService.indexBatch({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    entities,
    edges: [], // JNI edges are added separately: their method ends pre-date this report
  });

  // The method end of a `maps-to` edge is a pre-existing Java entity (from
  // the decompile index), so it can't ride the entity batch - indexBatch
  // only links entities it upserts itself. addEdge validates the workspace
  // and is a no-op on re-analysis (same derived id).
  let createdEdges = 0;
  let existingEdges = 0;
  for (const edge of edges) {
    const from = graphService.entityId(artifact.workspaceId, edge.from);
    const to = graphService.entityId(artifact.workspaceId, edge.to);
    const { created } = await graphService.addEdge({
      workspaceId: artifact.workspaceId,
      from,
      to,
      relation: "maps-to",
    });
    if (created) createdEdges++;
    else existingEdges++;
  }
  return {
    entities: result.entities,
    edges: { created: createdEdges, existing: existingEdges },
  };
}

/**
 * Subscribes to recorded artifacts and indexes ghidra's JSON reports.
 * Registered once at startup (see core/server.ts) beside the other graph
 * indexers; a failure is logged and never affects the analysis that produced
 * the artifact.
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "native-analysis" || artifact.pathType !== "file") return;
  try {
    await indexNativeArtifact(artifact);
  } catch (err) {
    console.warn(
      `[graph-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
