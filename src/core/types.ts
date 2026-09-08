export type WorkspaceStatus = "created" | "analyzing" | "ready" | "error";

export interface Workspace {
  id: string;
  name: string;
  targetLabel: string; // e.g. "com.example.app" - a user-supplied reference, not a file
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}

// The `| (string & {})` keeps autocomplete/hinting for the built-in kinds
// while still accepting arbitrary strings - required so plugins (see
// src/plugins/) can register new agent kinds without editing this type.
export type McpAgentKind =
  | "apktool"
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

export interface WorkflowStepSpec {
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
}

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
// side of a chat turn).
export type KnowledgeSource = "user" | "workflow" | "job" | "system";

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
