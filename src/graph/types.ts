export const ENTITY_TYPES = [
  "package",
  "class",
  "method",
  "native-function",
  "resource",
  "url",
  "secret-candidate",
  "runtime-event",
  "traffic-event",
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const RELATIONS = [
  "contains",
  "calls",
  "invokes",
  "maps-to",
  "accesses",
  "observed-by",
  "supports",
] as const;
export type Relation = (typeof RELATIONS)[number];

export type AttributeValue = string | number | boolean;

/**
 * Something observed about the target, identified by what it is (`type`) and
 * what it is called (`name`) within one workspace - so reporting the same
 * class twice updates one entity instead of creating two.
 */
export interface GraphEntity {
  /** Derived from workspace + type + name, so it is stable across upserts. */
  id: string;
  workspaceId: string;
  type: EntityType;
  /** Fully qualified where that makes sense, e.g. "com.acme.Login". Never a secret value. */
  name: string;
  attributes: Record<string, AttributeValue>;
  /** Artifacts this was observed in. Each must exist in the same workspace. */
  artifactIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A directed relationship between two entities of the same workspace. */
export interface GraphEdge {
  /** Derived from workspace + from + relation + to, so adding it twice is a no-op. */
  id: string;
  workspaceId: string;
  from: GraphEntity["id"];
  to: GraphEntity["id"];
  relation: Relation;
  createdAt: string;
}

export interface EntityInput {
  workspaceId: string;
  type: EntityType;
  name: string;
  attributes?: Record<string, AttributeValue>;
  artifactIds?: string[];
}

export interface EdgeInput {
  workspaceId: string;
  from: GraphEntity["id"];
  to: GraphEntity["id"];
  relation: Relation;
}

/** Names an entity by what identifies it, for edges inside a batch. */
export interface EntityRef {
  type: EntityType;
  name: string;
}

export interface BatchEntity extends EntityRef {
  attributes?: Record<string, AttributeValue>;
}

export interface BatchEdge {
  from: EntityRef;
  to: EntityRef;
  relation: Relation;
}

export interface BatchInput {
  workspaceId: string;
  /** The artifact every entity in the batch was observed in. */
  artifactId: string;
  entities: BatchEntity[];
  edges: BatchEdge[];
}

export interface BatchResult {
  entities: { created: number; updated: number };
  edges: { created: number; existing: number };
}
