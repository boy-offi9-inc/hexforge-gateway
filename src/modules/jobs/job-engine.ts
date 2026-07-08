import { nanoid } from "nanoid";
import type { Job, JobSpec } from "../../core/types.js";
import { eventBus } from "../../events/event-bus.js";
import type { EventMap } from "../../events/types.js";
import { orchestrator } from "../mcp/orchestrator.js";

/**
 * JobEngine wraps a single MCP task dispatch with retry logic. Per
 * HexForge_Architecture_v2.md's flow (Workspace -> Workflow -> Jobs ->
 * Tasks -> MCP Agents), a Job is the retryable unit; the Workflow Engine
 * composes several Jobs together, calling jobEngine.submit() the same
 * way a route can directly for a single-step case.
 *
 * A Job creates a fresh McpTask on each attempt (via the orchestrator) and
 * listens for that specific task's terminal state on the Event Bus. On
 * failure, if attempts remain, it dispatches a new task and tries again;
 * once attempts are exhausted (or the task succeeds), the Job reaches its
 * own terminal state and publishes job.completed / job.failed.
 */
class JobEngine {
  private jobs = new Map<string, Job>();

  getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  listJobsForWorkspace(workspaceId: string): Job[] {
    return Array.from(this.jobs.values()).filter((j) => j.workspaceId === workspaceId);
  }

  submit(spec: JobSpec): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: nanoid(12),
      workspaceId: spec.workspaceId,
      agent: spec.agent,
      operation: spec.operation,
      payload: spec.payload ?? {},
      status: "queued",
      attempts: 0,
      maxAttempts: spec.maxAttempts && spec.maxAttempts > 0 ? spec.maxAttempts : 1,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    eventBus.emit("job.created", { job });
    eventBus.emit("job.updated", { job });

    // Fire and forget - the first attempt (and any retries) run async;
    // updates flow out via job.* events, same pattern as the orchestrator.
    void this.runAttempt(job.id);

    return job;
  }

  private update(id: string, patch: Partial<Job>): Job | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.jobs.set(id, updated);

    eventBus.emit("job.updated", { job: updated });
    if (updated.status === "completed") eventBus.emit("job.completed", { job: updated });
    if (updated.status === "failed") eventBus.emit("job.failed", { job: updated });

    return updated;
  }

  private async runAttempt(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const attempts = job.attempts + 1;
    this.update(jobId, { status: "running", attempts });

    const task = await orchestrator.dispatch({
      workspaceId: job.workspaceId,
      agent: job.agent,
      operation: job.operation,
      payload: job.payload,
    });

    this.update(jobId, { currentTaskId: task.id });

    const handleTerminal = (latestTask: NonNullable<ReturnType<typeof orchestrator.getTask>>) => {
      if (latestTask.status === "completed") {
        this.update(jobId, { status: "completed", result: latestTask.result, error: undefined });
        return true;
      }
      if (latestTask.status === "failed") {
        const current = this.jobs.get(jobId);
        if (current && current.attempts < current.maxAttempts) {
          void this.runAttempt(jobId); // retry with a fresh task
        } else {
          this.update(jobId, { status: "failed", error: latestTask.error });
        }
        return true;
      }
      return false;
    };

    // Fast-failing tasks (e.g. an immediate validation error, no real I/O
    // wait) can reach a terminal state before we finish awaiting dispatch()
    // above - the orchestrator's own map is authoritative and synchronous
    // to read, so check it before subscribing rather than assuming we'll
    // always catch the event live.
    const maybeAlreadySettled = orchestrator.getTask(task.id);
    if (maybeAlreadySettled && handleTerminal(maybeAlreadySettled)) return;

    const onTaskUpdate = (payload: EventMap["mcp.task.updated"]) => {
      if (payload.task.id !== task.id) return; // not this attempt's task
      if (handleTerminal(payload.task)) {
        eventBus.off("mcp.task.updated", onTaskUpdate);
      }
    };

    eventBus.on("mcp.task.updated", onTaskUpdate);
  }
}

export const jobEngine = new JobEngine();
