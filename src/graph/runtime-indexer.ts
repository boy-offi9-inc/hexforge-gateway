import { readFile } from "node:fs/promises";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import type { BatchEntity, BatchEdge, BatchResult } from "./types.js";

/**
 * Runtime intelligence (private roadmap Phase 6): turns a runtime-events
 * artifact (JSONL hook observations from a Frida-style instrumentation run)
 * into `runtime-event` entities and links each one with `maps-to` edges to
 * the `method` entity it hooked and the `url` entity it reached - so a hook
 * observed at runtime and the static graph converge on the same entities.
 *
 * Producers: anything that records a `runtime-events` JSONL artifact - a
 * workflow step wrapping a streaming Frida session's log, or a hook script's
 * own dump. This indexer is event-driven like every other graph indexer.
 *
 * Redaction by design, same rule the traffic indexer follows: the event
 * name and attributes carry hook name, category, thread and timing, plus
 * the URL's method-less shape (query parameter NAMES kept, VALUES never,
 * see traffic-indexer). Hook arguments, return values and stack traces are
 * never stored - they are exactly the data instrumentation exists to see.
 */

export const MAX_RUNTIME_EVENTS = 5_000;

const CATEGORIES = new Set([
  "crypto",
  "network",
  "fs",
  "prefs",
  "webview",
  "ipc",
  "native",
  "other",
]);

/** One normalized hook observation (aggregated per hook name). */
export interface RuntimeEvent {
  /** Hook name as the instrumentation named it, e.g. `Java.com.acme.Crypto.encrypt`. */
  hook: string;
  /** One of the known categories, when given recognizably. */
  category?: string;
  /** Java methods the hook targets, e.g. `com.acme.Crypto.encrypt(String)` - matched exactly. */
  targets: string[];
  /** URL shapes (scheme://host/path, query dropped) the call reached - a network
   * hook typically fires against several. */
  urls: string[];
  /** Thread name the hook fired on, when the producer reports one. */
  thread?: string;
  /** Duration of the hooked call, when measured. */
  durationMs?: number;
  /** How many times this hook fired in the capture (aggregated by the indexer). */
  count: number;
}

/** A hook name is a name, not data: printable, bounded, no control chars. */
function saneHook(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hook = raw.trim();
  if (hook.length === 0 || hook.length > 200) return null;
  if (!/^[A-Za-z0-9_$.,:<>()[\]/ -]+$/.test(hook)) return null;
  return hook;
}

/** `scheme://host/path` from a URL string - the same shape url entities use.
 * Query values are dropped on purpose; only the path shape converges. */
export function urlEntityName(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol.slice(0, -1)}://${u.host}${u.pathname || "/"}`;
  } catch {
    return null;
  }
}

/** Pure part: one JSONL line -> a normalized event. Junk returns null. */
export function normalizeEvent(raw: unknown): RuntimeEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const hook = saneHook(r.hook);
  if (!hook) return null;

  const category =
    typeof r.category === "string" && CATEGORIES.has(r.category.trim().toLowerCase())
      ? r.category.trim().toLowerCase()
      : undefined;
  const target =
    typeof r.target === "string" && r.target.trim().length > 0 && r.target.trim().length <= 300
      ? r.target.trim()
      : undefined;
  const url = typeof r.url === "string" ? urlEntityName(r.url) ?? undefined : undefined;
  const thread =
    typeof r.thread === "string" && r.thread.trim().length > 0 && r.thread.trim().length <= 100
      ? r.thread.trim()
      : undefined;
  const durationMs =
    typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0
      ? Math.round(r.durationMs)
      : undefined;
  return { hook, category, targets: target ? [target] : [], urls: url ? [url] : [], thread, durationMs, count: 1 };
}

/** Pure part: a capture file's text -> normalized events (JSONL), aggregated
 * per unique hook so a hook firing 4000 times is one entity, count carried. */
export function parseCapture(content: string, max = MAX_RUNTIME_EVENTS): {
  events: RuntimeEvent[];
  truncated: boolean;
} {
  const byHook = new Map<string, RuntimeEvent>();
  let truncated = false;
  for (const line of content.split("\n")) {
    if (byHook.size >= max) {
      truncated = true;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: RuntimeEvent | null = null;
    try {
      event = normalizeEvent(JSON.parse(trimmed));
    } catch {
      continue; // skip malformed lines - a partial capture still indexes
    }
    if (!event) continue;
    const seen = byHook.get(event.hook);
    if (seen) {
      seen.count++;
      if (seen.durationMs === undefined && event.durationMs !== undefined) seen.durationMs = event.durationMs;
      // a hook fires against several methods/urls - union them, never keep
      // only the first sighting
      for (const t of event.targets) if (!seen.targets.includes(t)) seen.targets.push(t);
      for (const u of event.urls) if (!seen.urls.includes(u)) seen.urls.push(u);
      continue;
    }
    byHook.set(event.hook, event);
  }
  return { events: [...byHook.values()], truncated };
}

/** Pure part: events -> entities and maps-to edges. */
export function toEntitiesAndEdges(events: RuntimeEvent[]): {
  entities: BatchEntity[];
  edges: BatchEdge[];
} {
  const entities: BatchEntity[] = [];
  const edges: BatchEdge[] = [];
  for (const e of events) {
    const attrs: Record<string, string | number> = { count: e.count };
    if (e.category) attrs.category = e.category;
    if (e.thread) attrs.thread = e.thread;
    if (e.durationMs !== undefined) attrs.durationMs = e.durationMs;
    entities.push({ type: "runtime-event", name: e.hook, attributes: attrs });
    for (const target of e.targets) {
      edges.push({
        from: { type: "runtime-event", name: e.hook },
        to: { type: "method", name: target },
        relation: "maps-to",
      });
    }
    for (const url of e.urls) {
      edges.push({
        from: { type: "runtime-event", name: e.hook },
        to: { type: "url", name: url },
        relation: "maps-to",
      });
    }
  }
  return { entities, edges };
}

/**
 * Indexes one runtime-events artifact. Returns null when the artifact
 * holds no parsable events.
 */
export async function indexRuntimeEvents(artifact: Artifact): Promise<BatchResult | null> {
  if (artifact.pathType !== "file") return null;
  const content = await readFile(artifact.path, "utf8").catch(() => null);
  if (content === null) return null;
  const { events, truncated } = parseCapture(content);
  if (events.length === 0) return null;
  if (truncated) {
    console.warn(`[runtime-indexer] ${artifact.path}: runtime event extraction capped at ${MAX_RUNTIME_EVENTS}`);
  }

  const { entities, edges } = toEntitiesAndEdges(events);
  const result = await graphService.indexBatch({
    workspaceId: artifact.workspaceId,
    artifactId: artifact.id,
    entities,
    edges: [],
  });

  let createdEdges = 0;
  let existingEdges = 0;
  let skipped = 0;
  for (const edge of edges) {
    // both ends must exist: method entities come from the static indexers,
    // which may not have run yet - skipping keeps the runtime observation
    // without fabricating entities; a later indexing pass closes the gap
    const from = graphService.entityId(artifact.workspaceId, edge.from);
    const to = graphService.entityId(artifact.workspaceId, edge.to);
    if (!(await graphService.getEntity(from)) || !(await graphService.getEntity(to))) {
      skipped++;
      continue;
    }
    const { created } = await graphService.addEdge({
      workspaceId: artifact.workspaceId,
      from,
      to,
      relation: "maps-to",
    });
    if (created) createdEdges++;
    else existingEdges++;
  }
  console.log(
    `[runtime-indexer] ${artifact.path}: ${result.entities.created} created, ${result.entities.updated} updated, ${createdEdges} edges`,
  );
  return {
    entities: result.entities,
    edges: { created: createdEdges, existing: existingEdges + skipped },
  };
}

/**
 * Subscribes to recorded artifacts and indexes runtime event logs.
 * Registered once at startup (see core/server.ts).
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "runtime-events" || artifact.pathType !== "file") return;
  try {
    await indexRuntimeEvents(artifact);
  } catch (err) {
    console.warn(
      `[runtime-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
