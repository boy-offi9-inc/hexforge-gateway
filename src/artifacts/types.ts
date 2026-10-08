/**
 * An artifact is a tracked output of a task: a directory or file an agent
 * produced (decompiled sources, a decoded APK project, a rebuilt APK),
 * recorded with where it came from so it can be listed, found again, and
 * cited later as evidence.
 */
export interface Artifact {
  id: string;
  workspaceId: string;
  /** Kind declared by the operation's descriptor, e.g. "java-sources". */
  kind: string;
  /** Absolute path the agent reported. */
  path: string;
  pathType: "file" | "directory";
  /** The run that produced it (the most recent one, if the same path was produced again). */
  source: {
    taskId: string;
    agent: string;
    operation: string;
    /** Capability the operation provides, from the descriptor. */
    capability: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type ArtifactInput = Pick<Artifact, "workspaceId" | "kind" | "path" | "pathType" | "source">;
