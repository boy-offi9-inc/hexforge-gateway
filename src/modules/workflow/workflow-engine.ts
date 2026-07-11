import { nanoid } from "nanoid";
import type { Workflow, WorkflowSpec, WorkflowStepState } from "../../core/types.js";
import { eventBus } from "../../events/event-bus.js";
import type { EventMap } from "../../events/types.js";
import { jobEngine } from "../jobs/job-engine.js";

/**
 * WorkflowEngine composes several Jobs into one named operation (e.g.
 * "Analyze APK": extract manifest -> decompile -> index source -> generate
 * embeddings -> AI summary), per HexForge_Architecture_v2.md's flow
 * (Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents).
 *
 * Steps run strictly sequentially - the next step isn't dispatched until
 * the current one reaches a terminal Job state. Retries *within* a step
 * are already handled by the Job Engine (via each step's maxAttempts), so
 * the Workflow Engine only needs to react to a Job's completed/failed
 * state and either advance to the next step or stop the whole workflow.
 */
class WorkflowEngine {
  private workflows = new Map<string, Workflow>();

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  listWorkflowsForWorkspace(workspaceId: string): Workflow[] {
    return Array.from(this.workflows.values()).filter((w) => w.workspaceId === workspaceId);
  }

  submit(spec: WorkflowSpec): Workflow {
    if (spec.steps.length === 0) {
      throw new Error("A workflow requires at least one step");
    }

    const now = new Date().toISOString();
    const steps: WorkflowStepState[] = spec.steps.map((step) => ({
      agent: step.agent,
      operation: step.operation,
      payload: step.payload ?? {},
      maxAttempts: step.maxAttempts && step.maxAttempts > 0 ? step.maxAttempts : 1,
      mergePreviousResult: step.mergePreviousResult ?? false,
      status: "pending",
    }));

    const workflow: Workflow = {
      id: nanoid(12),
      workspaceId: spec.workspaceId,
      name: spec.name,
      status: "queued",
      currentStepIndex: 0,
      steps,
      createdAt: now,
      updatedAt: now,
    };
    this.workflows.set(workflow.id, workflow);
    eventBus.emit("workflow.created", { workflow });
    eventBus.emit("workflow.updated", { workflow });

    // Fire and forget - the whole step sequence runs async; updates flow
    // out via workflow.* events, same pattern as Job Engine / orchestrator.
    void this.runStep(workflow.id, 0);

    return workflow;
  }

  private update(id: string, patch: Partial<Workflow>): Workflow | undefined {
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.workflows.set(id, updated);

    eventBus.emit("workflow.updated", { workflow: updated });
    if (updated.status === "completed") eventBus.emit("workflow.completed", { workflow: updated });
    if (updated.status === "failed") eventBus.emit("workflow.failed", { workflow: updated });

    return updated;
  }

  private updateStep(id: string, index: number, patch: Partial<WorkflowStepState>): Workflow | undefined {
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    const steps = existing.steps.slice();
    steps[index] = { ...steps[index], ...patch };
    return this.update(id, { steps });
  }

  private async runStep(workflowId: string, index: number) {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return;

    if (index >= workflow.steps.length) {
      this.update(workflowId, { status: "completed", currentStepIndex: index });
      return;
    }

    const step = workflow.steps[index];
    const previous = index > 0 ? workflow.steps[index - 1] : undefined;
    const payload =
      step.mergePreviousResult && previous?.result && typeof previous.result === "object"
        ? { ...step.payload, ...(previous.result as Record<string, unknown>) }
        : step.payload;

    this.update(workflowId, { status: "running", currentStepIndex: index });
    this.updateStep(workflowId, index, { status: "queued", payload });

    const job = jobEngine.submit({
      workspaceId: workflow.workspaceId,
      agent: step.agent,
      operation: step.operation,
      payload,
      maxAttempts: step.maxAttempts,
    });

    this.updateStep(workflowId, index, { jobId: job.id, status: "running" });

    const handleTerminal = (latestJob: NonNullable<ReturnType<typeof jobEngine.getJob>>) => {
      if (latestJob.status === "completed") {
        this.updateStep(workflowId, index, { status: "completed", result: latestJob.result, error: undefined });
        void this.runStep(workflowId, index + 1);
        return true;
      }
      if (latestJob.status === "failed") {
        this.updateStep(workflowId, index, { status: "failed", error: latestJob.error });
        this.update(workflowId, { status: "failed", error: `Step ${index} ("${step.agent}:${step.operation}") failed: ${latestJob.error}` });
        return true;
      }
      return false;
    };

    // Fast-failing jobs (e.g. immediate validation errors) can reach a
    // terminal state before we finish awaiting submit() above - the Job
    // Engine's own map is authoritative and synchronous to read, so check
    // it before subscribing rather than assuming we'll always catch the
    // event live. Same defensive pattern the Job Engine uses against the
    // orchestrator.
    const maybeAlreadySettled = jobEngine.getJob(job.id);
    if (maybeAlreadySettled && handleTerminal(maybeAlreadySettled)) return;

    const onJobUpdate = (payload: EventMap["job.updated"]) => {
      if (payload.job.id !== job.id) return; // not this step's job
      if (handleTerminal(payload.job)) {
        eventBus.off("job.updated", onJobUpdate);
      }
    };

    eventBus.on("job.updated", onJobUpdate);
  }
}

export const workflowEngine = new WorkflowEngine();
