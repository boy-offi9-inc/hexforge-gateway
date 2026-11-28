import { createHash } from "node:crypto";
import { localStorageProvider } from "../providers/storage.provider.js";
import { eventBus } from "../events/event-bus.js";
import { missingArtifactIds } from "../artifacts/artifact.service.js";
import type {
  BatchInput,
  BatchResult,
  EdgeInput,
  EntityInput,
  EntityType,
  GraphEdge,
  GraphEntity,
  Relation,
} from "./types.js";

// Local storage only, like artifacts and findings: no database tables yet.
const ENTITIES = "graph_entities";
const EDGES = "graph_edges";

const localStore = localStorageProvider();

/** A reference in the graph is invalid. Callers (the routes) turn this into a 400. */
export class GraphError extends Error {}

/**
 * Ids come from what the record *is*, not from a counter, so upserting the
 * same entity (or adding the same edge) twice finds the existing record with
 * a single lookup instead of scanning the collection.
 */
/** The stable entity id for a workspace + type + name (same derivation the upserts use). */
export function entityId(workspaceId: string, ref: { type: EntityType; name: string }): string {
  return stableId(workspaceId, ref.type, ref.name);
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);
}

/**
 * Creates the entity, or - if this workspace already has one of that type and
 * name - merges into it: attributes are overlaid (new values win) and artifact
 * ids are unioned. Cited artifacts must exist in the same workspace.
 */
export async function upsertEntity(
  input: EntityInput,
): Promise<{ entity: GraphEntity; created: boolean }> {
  const artifactIds = [...new Set(input.artifactIds ?? [])];
  const missing = await missingArtifactIds(input.workspaceId, artifactIds);
  if (missing.length > 0) {
    throw new GraphError(
      `Entity cites artifact(s) not found in this workspace: ${missing.join(", ")}`,
    );
  }

  const id = stableId(input.workspaceId, input.type, input.name);
  const existing = await localStore.getRecord<GraphEntity>(ENTITIES, id);
  const now = new Date().toISOString();

  if (existing) {
    const entity: GraphEntity = {
      ...existing,
      attributes: { ...existing.attributes, ...input.attributes },
      artifactIds: [...new Set([...existing.artifactIds, ...artifactIds])],
      updatedAt: now,
    };
    await localStore.upsertRecord(ENTITIES, entity);
    eventBus.emit("graph.entity_upserted", { entity, created: false });
    return { entity, created: false };
  }

  const entity: GraphEntity = {
    id,
    workspaceId: input.workspaceId,
    type: input.type,
    name: input.name,
    attributes: input.attributes ?? {},
    artifactIds,
    createdAt: now,
    updatedAt: now,
  };
  await localStore.upsertRecord(ENTITIES, entity);
  eventBus.emit("graph.entity_upserted", { entity, created: true });
  return { entity, created: true };
}

export async function getEntity(id: string): Promise<GraphEntity | null> {
  return localStore.getRecord<GraphEntity>(ENTITIES, id);
}

/** Sorted by name. `q` is a case-insensitive substring of the name. */
export async function listEntities(
  workspaceId: string,
  filter: { type?: EntityType; q?: string } = {},
): Promise<GraphEntity[]> {
  const q = filter.q?.toLowerCase();
  const all = await localStore.listRecords<GraphEntity>(ENTITIES);
  return all
    .filter(
      (e) =>
        e.workspaceId === workspaceId &&
        (!filter.type || e.type === filter.type) &&
        (!q || e.name.toLowerCase().includes(q)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Adds a directed edge. Both ends must be entities of this workspace; the
 * only allowed self-edge is `invokes` (reflection's whole-file marker). Adding
 * an edge that already exists changes nothing and reports `created: false`.
 */
export async function addEdge(input: EdgeInput): Promise<{ edge: GraphEdge; created: boolean }> {
  // Reflection is recorded as a self-looped `invokes` edge on the calling
  // class (see calls-indexer.ts) - the one sanctioned self-edge.
  if (input.from === input.to && input.relation !== "invokes") {
    throw new GraphError("An edge can't connect an entity to itself");
  }
  for (const entityId of [input.from, input.to]) {
    const entity = await getEntity(entityId);
    if (!entity || entity.workspaceId !== input.workspaceId) {
      throw new GraphError(`Entity not found in this workspace: ${entityId}`);
    }
  }

  const id = stableId(input.workspaceId, input.from, input.relation, input.to);
  const existing = await localStore.getRecord<GraphEdge>(EDGES, id);
  if (existing) return { edge: existing, created: false };

  const edge: GraphEdge = {
    id,
    workspaceId: input.workspaceId,
    from: input.from,
    to: input.to,
    relation: input.relation,
    createdAt: new Date().toISOString(),
  };
  await localStore.upsertRecord(EDGES, edge);
  eventBus.emit("graph.edge_created", { edge });
  return { edge, created: true };
}

/** `entityId` matches an edge at either end. */
export async function listEdges(
  workspaceId: string,
  filter: { entityId?: string; relation?: Relation } = {},
): Promise<GraphEdge[]> {
  const all = await localStore.listRecords<GraphEdge>(EDGES);
  return all
    .filter(
      (e) =>
        e.workspaceId === workspaceId &&
        (!filter.relation || e.relation === filter.relation) &&
        (!filter.entityId || e.from === filter.entityId || e.to === filter.entityId),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The entity and every edge touching it, or null if it doesn't exist. */
export async function getEntityWithEdges(
  id: string,
): Promise<{ entity: GraphEntity; edges: GraphEdge[] } | null> {
  const entity = await getEntity(id);
  if (!entity) return null;
  return { entity, edges: await listEdges(entity.workspaceId, { entityId: id }) };
}

export interface TraverseOptions {
  /** Only walk edges of this relation, e.g. `calls` for a who-calls query. */
  relation?: Relation;
  /** Which way to walk from the start node. Default `out`. */
  direction?: "out" | "in" | "both";
  /** How many hops to walk (1-3). Default 1. */
  depth?: number;
  /** Hard cap on collected edges, so a hub node cannot stall a request. */
  maxEdges?: number;
}

export interface TraversalResult {
  root: GraphEntity;
  /** Every edge found within the depth budget, both ends resolved. */
  edges: { edge: GraphEdge; from: GraphEntity; to: GraphEntity }[];
  /** Distinct entities touched, root included. Sorted by type then name. */
  entities: GraphEntity[];
  /** True when the cap cut the walk short before the depth budget ran out. */
  truncated: boolean;
}

/**
 * Answers graph questions, not list questions: walk the graph out from one
 * entity following `relation` edges (who calls this class, what does this
 * method access, which runtime events hooked it), BFS up to `depth` hops,
 * both ends resolved to full entities so a consumer never needs a second
 * round trip. Bounded by maxEdges - a `contains` walk from a package root
 * must not load the whole graph.
 */
export async function traverseGraph(
  workspaceId: string,
  startId: string,
  { relation, direction = "out", depth = 1, maxEdges = 500 }: TraverseOptions = {},
): Promise<TraversalResult | null> {
  const root = await getEntity(startId);
  if (!root || root.workspaceId !== workspaceId) return null;

  const hops = Math.min(3, Math.max(1, Math.floor(depth)));
  const cap = Math.min(2000, Math.max(1, Math.floor(maxEdges)));

  const entities = new Map<string, GraphEntity>([[root.id, root]]);
  const edges: TraversalResult["edges"] = [];
  let truncated = false;
  let frontier = [root.id];

  for (let hop = 0; hop < hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const nodeId of frontier) {
      const found = await listEdges(workspaceId, { entityId: nodeId, relation });
      for (const edge of found) {
        const neighborId = edge.from === nodeId ? edge.to : edge.from;
        const outgoing = edge.from === nodeId;
        if (direction === "out" && !outgoing) continue;
        if (direction === "in" && outgoing) continue;
        if (edges.some((e) => e.edge.id === edge.id)) continue;
        if (edges.length >= cap) {
          truncated = true;
          break;
        }
        const from = entities.get(edge.from) ?? (await getEntity(edge.from));
        const to = entities.get(edge.to) ?? (await getEntity(edge.to));
        if (!from || !to) continue;
        entities.set(from.id, from);
        entities.set(to.id, to);
        edges.push({ edge, from, to });
        if (!next.includes(neighborId)) next.push(neighborId);
      }
      if (truncated) break;
    }
    if (truncated) break;
    frontier = next;
  }

  const sorted = [...entities.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
  );
  return { root, edges, entities: sorted, truncated };
}

/**
 * Adds many entities and edges in one go, for indexers that report thousands
 * of things from a single artifact. Same merge rules as upsertEntity and
 * addEdge, but with one write per collection instead of one per record
 * (every write rewrites the whole collection file), and one `graph.indexed`
 * event instead of one per record.
 *
 * Edges name their ends by type + name and both must be in this batch; the
 * artifact must exist in the workspace. Nothing is written if validation fails.
 */
export async function indexBatch(input: BatchInput): Promise<BatchResult> {
  const missing = await missingArtifactIds(input.workspaceId, [input.artifactId]);
  if (missing.length > 0) {
    throw new GraphError(`Artifact not found in this workspace: ${input.artifactId}`);
  }

  const idOf = (ref: { type: EntityType; name: string }) =>
    stableId(input.workspaceId, ref.type, ref.name);

  const batch = new Map<string, EntityInput>();
  for (const e of input.entities) {
    const id = idOf(e);
    const prior = batch.get(id);
    batch.set(id, {
      workspaceId: input.workspaceId,
      type: e.type,
      name: e.name,
      attributes: { ...prior?.attributes, ...e.attributes },
    });
  }

  const edgeIds = new Map<string, { from: string; to: string; relation: Relation }>();
  for (const e of input.edges) {
    const from = idOf(e.from);
    const to = idOf(e.to);
    if (!batch.has(from) || !batch.has(to)) {
      throw new GraphError(
        `Edge ${e.relation} ${e.from.name} -> ${e.to.name} names an entity that isn't in the batch`,
      );
    }
    // Reflection's `invokes` marker is a sanctioned self-loop; anything
    // else connecting an entity to itself is a parser bug.
    if (from === to && e.relation !== "invokes") {
      throw new GraphError("An edge can't connect an entity to itself");
    }
    const id = stableId(input.workspaceId, from, e.relation, to);
    edgeIds.set(id, { from, to, relation: e.relation });
  }

  const now = new Date().toISOString();
  const entities: GraphEntity[] = [];
  let createdEntities = 0;
  for (const [id, e] of batch) {
    const existing = await localStore.getRecord<GraphEntity>(ENTITIES, id);
    if (existing) {
      entities.push({
        ...existing,
        attributes: { ...existing.attributes, ...e.attributes },
        artifactIds: [...new Set([...existing.artifactIds, input.artifactId])],
        updatedAt: now,
      });
    } else {
      createdEntities++;
      entities.push({
        id,
        workspaceId: input.workspaceId,
        type: e.type,
        name: e.name,
        attributes: e.attributes ?? {},
        artifactIds: [input.artifactId],
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  const newEdges: GraphEdge[] = [];
  for (const [id, e] of edgeIds) {
    if (await localStore.getRecord<GraphEdge>(EDGES, id)) continue;
    newEdges.push({ id, workspaceId: input.workspaceId, ...e, createdAt: now });
  }

  await localStore.upsertRecords(ENTITIES, entities);
  await localStore.upsertRecords(EDGES, newEdges);

  const result: BatchResult = {
    entities: { created: createdEntities, updated: entities.length - createdEntities },
    edges: { created: newEdges.length, existing: edgeIds.size - newEdges.length },
  };
  eventBus.emit("graph.indexed", {
    workspaceId: input.workspaceId,
    artifactId: input.artifactId,
    ...result,
  });
  return result;
}
