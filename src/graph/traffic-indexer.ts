import { readFile } from "node:fs/promises";
import { eventBus } from "../events/event-bus.js";
import type { EventMap } from "../events/types.js";
import type { Artifact } from "../artifacts/types.js";
import * as graphService from "./graph.service.js";
import type { BatchEntity, BatchEdge, BatchResult } from "./types.js";

/**
 * Network intelligence, evidence half (private roadmap 4A): turns a traffic
 * capture artifact into `traffic-event` entities in the knowledge graph and
 * links each one with a `maps-to` edge to the `url` entity it hit - so a
 * URL discovered statically and a request actually made at runtime converge
 * on the same entity. The capture producers (a mitmproxy-style agent, or a
 * workflow step collecting device traffic) record a `traffic-capture`
 * artifact; this indexer is event-driven like every other graph indexer.
 *
 * Redaction by design, same rule the secret scanner follows: the event
 * name and attributes carry method, scheme, host, path, status, content
 * type and timing - query parameter NAMES are kept, their VALUES never
 * are (tokens and session ids ride in query strings), and no header
 * values or bodies are stored at all.
 */

export const MAX_TRAFFIC_EVENTS = 5_000;

/** One normalized request/response observation. */
export interface TrafficEvent {
  method: string;
  scheme: string;
  host: string;
  path: string;
  status?: number;
  contentType?: string;
  durationMs?: number;
  queryKeys?: string[];
}

/** Entity name for one event: `METHOD scheme://host path`. The scheme is
 * part of the name so an http and an https request to the same host/path
 * stay distinct entities (they can point at different url entities). The
 * query string is dropped on purpose - see the redaction note above. Note:
 * a request's url-entity edge only converges with a static url entity when
 * the static side recorded the bare origin+path (no query) - URLs with a
 * query in the code don't converge yet. */
export function eventName(e: TrafficEvent): string {
  return `${e.method} ${e.scheme}://${e.host}${e.path}`;
}

/** The url-entity name a request to this event would have hit statically. */
function urlEntityName(e: TrafficEvent): string {
  return `${e.scheme}://${e.host}${e.path}`;
}

/** Parse query key names (never values) from a URL query string. A key
 * with malformed percent-encoding falls back to its raw form rather than
 * throwing - one hostile query string must not kill the event. */
export function queryKeysOf(search: string): string[] | undefined {
  if (!search || search === "?") return undefined;
  const keys = [
    ...new Set(
      search
        .replace(/^\?/, "")
        .split("&")
        .filter(Boolean)
        .map((pair) => {
          const eq = pair.indexOf("=");
          const key = eq === -1 ? pair : pair.slice(0, eq);
          try {
            return decodeURIComponent(key).trim();
          } catch {
            return key.trim();
          }
        })
        .filter(Boolean),
    ),
  ];
  return keys.length > 0 ? keys : undefined;
}

function parseUrl(raw: string): { scheme: string; host: string; path: string; search: string } | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { scheme: u.protocol.slice(0, -1), host: u.host, path: u.pathname || "/", search: u.search };
  } catch {
    return null;
  }
}

/** Pure part: one JSONL line or one HAR entry -> a normalized event. */
export function normalizeEvent(raw: unknown): TrafficEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  // HAR entry shape
  if ("request" in r && typeof r.request === "object" && r.request !== null) {
    const req = r.request as Record<string, unknown>;
    const res = (typeof r.response === "object" && r.response !== null ? r.response : {}) as Record<string, unknown>;
    const method = (typeof req.method === "string" ? req.method : "").trim().toUpperCase();
    const url = typeof req.url === "string" ? req.url : "";
    const parsed = parseUrl(url);
    if (!/^[A-Z]+$/.test(method) || !parsed) return null;
    const headers = Array.isArray(req.headers) ? (req.headers as Array<Record<string, unknown>>) : [];
    const contentType =
      headers.find((h) => typeof h.name === "string" && h.name.toLowerCase() === "content-type")?.value;
    const time =
      typeof r.time === "number" && Number.isFinite(r.time) && r.time >= 0 ? Math.round(r.time) : undefined;
    const status =
      typeof res.status === "number" && Number.isInteger(res.status) && res.status >= 0 && res.status <= 599
        ? res.status
        : undefined;
    return {
      method,
      scheme: parsed.scheme,
      host: parsed.host,
      path: parsed.path,
      status,
      contentType: typeof contentType === "string" ? contentType.split(";")[0] : undefined,
      durationMs: time,
      queryKeys: queryKeysOf(parsed.search),
    };
  }

  // flat JSONL event shape: { method, url, status?, contentType?, durationMs? }
  const method = (typeof r.method === "string" ? r.method : "").trim().toUpperCase();
  const url = typeof r.url === "string" ? r.url : "";
  const parsed = parseUrl(url);
  if (!/^[A-Z]+$/.test(method) || !parsed) return null;
  const status = typeof r.status === "number" && Number.isInteger(r.status) && r.status >= 0 && r.status <= 599
    ? r.status
    : undefined;
  const durationMs =
    typeof r.durationMs === "number" && Number.isFinite(r.durationMs) && r.durationMs >= 0
      ? Math.round(r.durationMs)
      : undefined;
  return {
    method,
    scheme: parsed.scheme,
    host: parsed.host,
    path: parsed.path,
    status,
    contentType: typeof r.contentType === "string" ? r.contentType.split(";")[0] : undefined,
    durationMs,
    queryKeys: queryKeysOf(parsed.search),
  };
}

/** Pure part: a capture file's text -> normalized events (JSONL or HAR). */
/** True when the text should be parsed as a HAR document rather than JSONL.
 * One decision, used by parseCapture (which format to parse) and the capture
 * route (which extension to store), so a stored file's extension always
 * matches what the indexer will do with it. */
export function looksLikeHar(content: string): boolean {
  const nl = content.indexOf("\n");
  const firstLine = content.slice(0, nl === -1 ? content.length : nl).trim();
  return firstLine.startsWith("{") && content.includes('"log"') && content.includes('"entries"');
}

export function parseCapture(content: string, max = MAX_TRAFFIC_EVENTS): {
  events: TrafficEvent[];
  truncated: boolean;
} {
  const out: TrafficEvent[] = [];
  let truncated = false;
  // HAR is a JSON document; JSONL is one event per line. A HAR document
  // starts with a '{' and its first line is never a complete JSON object.
  if (looksLikeHar(content)) {
    try {
      const har = JSON.parse(content) as { log?: { entries?: unknown[] } };
      for (const entry of har.log?.entries ?? []) {
        if (out.length >= max) {
          truncated = true;
          break;
        }
        try {
          const e = normalizeEvent(entry);
          if (e) out.push(e);
        } catch {
          // one malformed HAR entry never kills the rest of the capture
        }
      }
      return { events: out, truncated };
    } catch {
      // fall through to JSONL - a malformed HAR yields nothing either way
    }
  }
  for (const line of content.split("\n")) {
    if (out.length >= max) {
      truncated = true;
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = normalizeEvent(JSON.parse(trimmed));
      if (e) out.push(e);
    } catch {
      // skip malformed lines - a partial capture still indexes
    }
  }
  return { events: out, truncated };
}

/** Pure part: events -> entities and maps-to edges (to url entities). */
export function toEntitiesAndEdges(events: TrafficEvent[]): {
  entities: BatchEntity[];
  edges: BatchEdge[];
} {
  const entities = new Map<string, BatchEntity>();
  const edges: BatchEdge[] = [];
  for (const e of events) {
    const name = eventName(e);
    if (!entities.has(name)) {
      const attrs: Record<string, string | number> = {};
      attrs.scheme = e.scheme;
      if (e.status !== undefined) attrs.status = e.status;
      if (e.contentType) attrs.contentType = e.contentType;
      if (e.durationMs !== undefined) attrs.durationMs = e.durationMs;
      if (e.queryKeys) attrs.queryKeys = e.queryKeys.join(",");
      entities.set(name, { type: "traffic-event", name, attributes: attrs });
    }
    edges.push({
      from: { type: "traffic-event", name },
      to: { type: "url", name: urlEntityName(e) },
      relation: "maps-to",
    });
  }
  return { entities: [...entities.values()], edges };
}

/**
 * Indexes one traffic-capture artifact. Returns null when the artifact
 * holds no parsable events.
 */
export async function indexTrafficCapture(artifact: Artifact): Promise<BatchResult | null> {
  if (artifact.pathType !== "file") return null;
  const content = await readFile(artifact.path, "utf8").catch(() => null);
  if (content === null) return null;
  const { events, truncated } = parseCapture(content);
  if (events.length === 0) return null;
  if (truncated) {
    console.warn(`[traffic-indexer] ${artifact.path}: traffic event extraction capped at ${MAX_TRAFFIC_EVENTS}`);
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
    // both ends must exist: url entities come from the static indexers,
    // which may not have run yet - skipping keeps the runtime observation
    // without fabricating a url entity; a later indexing pass closes the gap
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
    `[traffic-indexer] ${artifact.path}: ${result.entities.created} created, ${result.entities.updated} updated, ${createdEdges} edges`,
  );
  return {
    entities: result.entities,
    edges: { created: createdEdges, existing: existingEdges + skipped },
  };
}

/**
 * Subscribes to recorded artifacts and indexes traffic captures.
 * Registered once at startup (see core/server.ts).
 */
export function register() {
  eventBus.on("artifact.created", onArtifact);
  eventBus.on("artifact.updated", onArtifact);
}

async function onArtifact({ artifact }: EventMap["artifact.created"]) {
  if (artifact.kind !== "traffic-capture" || artifact.pathType !== "file") return;
  try {
    await indexTrafficCapture(artifact);
  } catch (err) {
    console.warn(
      `[traffic-indexer] could not index artifact ${artifact.id}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
