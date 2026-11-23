export type WorkspaceStatus = "created" | "analyzing" | "ready" | "error";

export interface Workspace {
  id: string;
  name: string;
  targetLabel: string; // e.g. "com.example.app" - a user-supplied reference, not a file
  status: WorkspaceStatus;
  /**
   * Optional workspace-scoped AI provider override (per-workspace provider
   * selection). A built-in name or one from the AI_PROVIDERS_PATH file;
   * validated at set time. Unset means the global AI_PROVIDER applies.
   */
  aiProvider?: string;
  createdAt: string;
  updatedAt: string;
}

// The `| (string & {})` keeps autocomplete/hinting for the built-in kinds
// while still accepting arbitrary strings - required so plugins (see
// src/plugins/) can register new agent kinds without editing this type.
export type McpAgentKind =
  "apktool"
  | "apksigner"
  | "jadx"
  | "frida"
  | "adb"
  | "filesystem"
  | "apkmcp"
  | "ai"
  | (string & {});

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface McpTask {
  id: string;
  workspaceId: string;
  agent: McpAgentKind;
  operation: string;
  payload: Record<string, unknown>;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
}

export interface TaskDispatchRequest {
  workspaceId: string;
  agent: McpAgentKind;
  operation: string;
  payload?: Record<string, unknown>;
}

// --- Job Engine types ----------------------------------------------------
// A Job wraps a single MCP task dispatch with retry logic. Per
// Per the Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents flow,
// a Job is the retryable unit; the Workflow Engine
// composes several of these together, calling JobEngine.submit() the
// same way a caller can directly for a single-step case.

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobSpec {
  workspaceId: string;
  agent: McpAgentKind;
  operation: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number; // default 1 (no retry) if omitted
}

export interface Job {
  id: string;
  workspaceId: string;
  agent: McpAgentKind;
  operation: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  currentTaskId?: string; // the McpTask currently backing this attempt
  createdAt: string;
  updatedAt: string;
  result?: unknown;
  error?: string;
  /** How many times a failed job has been resumed. */
  resumeCount?: number;
}

// --- Workflow Engine types ------------------------------------------------
// A Workflow composes several Jobs into one named operation (e.g. "Analyze
// APK": extract manifest -> decompile -> index source -> ...), per the
// Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents flow. It runs its
// steps sequentially, submitting one Job at a time via JobEngine.submit()
// - retries within a step are already handled
// by the Job Engine, so the Workflow Engine only needs to react to each
// step's terminal state and either advance or stop.

export type WorkflowStatus = "queued" | "running" | "completed" | "failed";

export interface WorkflowSingleStepSpec {
  agent: McpAgentKind;
  operation: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number; // forwarded to JobEngine.submit(), default 1
  // If true, the previous step's result is shallow-merged into this step's
  // payload before dispatch (result keys win on conflict) - e.g. feeding a
  // decompile step's `outputDir` into the next step's payload without the
  // caller having to know it ahead of time.
  mergePreviousResult?: boolean;
}

/**
 * Several steps that run at the same time. The group finishes when every branch
 * has; its result is { results, failed, errors? } - one entry per branch, in order.
 * Unless `continueOnError` is set, one failed branch fails the group (the others
 * still run to the end, since a running job can't be recalled).
 */
export interface WorkflowParallelStepSpec {
  parallel: WorkflowSingleStepSpec[];
  continueOnError?: boolean;
}

/**
 * A fan-out step: one step template that is cloned once per item of a list
 * that only exists at runtime - the previous step's result. The list is
 * resolved from the previous result: an array result is the list itself; an
 * object result is looked up at the `from` key (dot paths like
 * "output.files" work). Each item is shallow-merged into the step's payload
 * when the item is an object, otherwise it lands under the `item` key - the
 * same per-branch payload rules a parallel group uses, except the branches
 * are derived from data instead of written out.
 */
export interface WorkflowFanOutStepSpec {
  fanOut: WorkflowSingleStepSpec;
  /** Key (dot path) in the previous step's result holding the list, for object results. */
  from?: string;
  /** Safety cap on branch count (default 20, matching a parallel group's max). */
  maxBranches?: number;
  continueOnError?: boolean;
}

export type WorkflowStepSpec =
  | WorkflowSingleStepSpec
  | WorkflowParallelStepSpec
  | WorkflowFanOutStepSpec;

export interface WorkflowSpec {
  workspaceId: string;
  name: string;
  steps: WorkflowStepSpec[];
}

export type WorkflowStepStatus = "pending" | "queued" | "running" | "completed" | "failed";

export interface WorkflowStepState {
  agent: McpAgentKind;
  operation: string;
  payload: Record<string, unknown>;
  maxAttempts: number;
  mergePreviousResult: boolean;
  status: WorkflowStepStatus;
  jobId?: string;
  result?: unknown;
  error?: string;
  /**
   * Present on a parallel group, whose `agent` is "parallel" and `operation` is
   * "group"; each branch is tracked like a step of its own.
   */
  branches?: WorkflowBranchState[];
  continueOnError?: boolean;
  /**
   * Present on a fan-out step (`agent: "fanout"`, `operation: "list"`); the
   * branches are derived from the previous step's result when the step runs,
   * not at submit time. Persisted so a resume re-derives the same list.
   */
  fanOut?: WorkflowFanOutStepSpec;
}

export type WorkflowBranchState = Omit<WorkflowStepState, "branches" | "continueOnError">;

export interface Workflow {
  id: string;
  workspaceId: string;
  name: string;
  status: WorkflowStatus;
  currentStepIndex: number;
  steps: WorkflowStepState[];
  createdAt: string;
  updatedAt: string;
  error?: string;
  /** How many times a failed workflow has been resumed from where it stopped. */
  resumeCount?: number;
}

// --- Knowledge Engine types -----------------------------------------------
// The Knowledge Engine stores chats,
// reports, notes, embeddings, relationships, and summaries, and is updated
// as step 6 of the Data Flow ("Results are indexed... Knowledge Engine
// updates memory"). A KnowledgeEntry is the one shape all of those collapse
// into - `type` distinguishes them. `embedding` stays unused: nothing in
// this project generates embeddings yet.

export type KnowledgeEntryType = "chat" | "note" | "report" | "summary";
// Where an entry came from: "user" for anything created directly via the
// API or typed by a person in chat, "workflow"/"job" for entries the
// Knowledge Indexer auto-generates from completed/failed runs, "system"
// for AI-generated content (a summarizeEntry() result, or the assistant's
// side of a chat turn), "inbox" for entries the inbox watcher creates
// when it claims a dropped APK - genuinely the user's own action (they
// placed the file), but not something they typed via the API, so it gets
// its own value rather than overloading "user" or "system" with a
// meaning neither quite has.
export type KnowledgeSource = "user" | "workflow" | "job" | "system" | "inbox";

export interface KnowledgeEntry {
  id: string;
  workspaceId: string;
  type: KnowledgeEntryType;
  title: string;
  content: string;
  source: KnowledgeSource;
  sourceId?: string; // e.g. the workflowId or jobId that generated this entry
  relatedEntryIds: string[];
  embedding?: number[]; // unused - nothing in this project generates embeddings yet
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeEntryInput {
  workspaceId: string;
  type: KnowledgeEntryType;
  title: string;
  content: string;
  source?: KnowledgeSource; // default "user"
  sourceId?: string;
  relatedEntryIds?: string[];
}

export interface KnowledgeEntryUpdate {
  title?: string;
  content?: string;
  relatedEntryIds?: string[];
  embedding?: number[];
}
