import { nanoid } from "nanoid";
import type {
  Job,
  Workflow,
  WorkflowBranchState,
  WorkflowSingleStepSpec,
  WorkflowSpec,
  WorkflowStepSpec,
  WorkflowStepState,
} from "../../core/types.js";
import { eventBus } from "../../events/event-bus.js";
import type { EventMap } from "../../events/types.js";
import { jobEngine } from "../jobs/job-engine.js";
import * as workflowService from "./workflow.service.js";

function persist(workflow: Workflow) {
  // Fire and forget, mirroring job-engine.ts's persist() - a failed write
  // shouldn't stall or crash the live workflow.
  void workflowService.persistWorkflow(workflow).catch((err) => {
    console.warn(`[workflow-engine] failed to persist workflow ${workflow.id}:`, err);
  });
}

const RESTART_ERROR = "Interrupted by a Gateway restart";

function singleState(step: WorkflowSingleStepSpec): WorkflowBranchState {
  return {
    agent: step.agent,
    operation: step.operation,
    payload: step.payload ?? {},
    maxAttempts: step.maxAttempts && step.maxAttempts > 0 ? step.maxAttempts : 1,
    mergePreviousResult: step.mergePreviousResult ?? false,
    status: "pending",
  };
}

function stepState(step: WorkflowStepSpec): WorkflowStepState {
  if (!("parallel" in step)) return singleState(step);
  if (step.parallel.length < 2) {
    throw new Error("A parallel step needs at least two branches; use a plain step for one");
  }
  return {
    agent: "parallel",
    operation: "group",
    payload: {},
    maxAttempts: 1,
    mergePreviousResult: false,
    status: "pending",
    branches: step.parallel.map(singleState),
    continueOnError: step.continueOnError ?? false,
  };
}

/** The payload to dispatch: the step's own, with the previous step's result merged in if asked. */
function payloadFor(
  step: Pick<WorkflowBranchState, "payload" | "mergePreviousResult">,
  previous: WorkflowStepState | undefined,
): Record<string, unknown> {
  return step.mergePreviousResult && previous?.result && typeof previous.result === "object"
    ? { ...step.payload, ...(previous.result as Record<string, unknown>) }
    : step.payload;
}

const isTerminal = (job: Job) => job.status === "completed" || job.status === "failed";

/**
 * WorkflowEngine composes several Jobs into one named operation (e.g.
 * "Analyze APK": extract manifest -> decompile -> index source -> generate
 * embeddings -> AI summary), per the
 * Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents flow.
 *
 * Steps run one after another - the next step isn't dispatched until the
 * current one reaches a terminal state. A step can also be a parallel group,
 * whose branches run at the same time and which finishes when all of them have.
 * Retries *within* a step or branch are already handled by the Job Engine
 * (via maxAttempts), so the Workflow Engine only reacts to a Job's
 * completed/failed state and either advances or stops the whole workflow.
 *
 * A workflow that failed - a step failed, or the Gateway restarted under it -
 * can be resumed: it continues from the first step that didn't complete,
 * keeping the results of the ones that did.
 */
class WorkflowEngine {
  private workflows = new Map<string, Workflow>();

  getWorkflow(id: string): Workflow | undefined {
    return this.workflows.get(id);
  }

  /**
   * Repopulates the in-memory Map from persisted storage. Call once at
   * boot, before the server starts accepting requests. A workflow left
   * "running" or "queued" from before the restart has no live Job behind
   * it (JobEngine.hydrate() already fails any of those), so it is marked
   * "failed" - along with whichever of its steps or branches were in flight -
   * rather than left looking like it's still advancing. It is not run again on
   * its own, because the step that was in flight may have half-run; resume it
   * with `resume()` once you've decided that's safe.
   */
  async hydrate(): Promise<void> {
    const workflows = await workflowService.listAllWorkflows();
    for (const workflow of workflows) {
      if (workflow.status === "running" || workflow.status === "queued") {
        const inFlight = (s: { status: string }) => s.status === "queued" || s.status === "running";
        const interrupted = (s: WorkflowBranchState) =>
          inFlight(s) ? { ...s, status: "failed" as const, error: RESTART_ERROR } : s;
        const steps = workflow.steps.map((step) => {
          const marked = interrupted(step) as WorkflowStepState;
          return step.branches ? { ...marked, branches: step.branches.map(interrupted) } : marked;
        });
        const corrected: Workflow = {
          ...workflow,
          steps,
          status: "failed",
          error:
            `${RESTART_ERROR} before this workflow finished (it stopped at step ` +
            `${workflow.currentStepIndex}). Resume it to continue from there: ` +
            `POST /workflows/${workflow.id}/resume.`,
          updatedAt: new Date().toISOString(),
        };
        this.workflows.set(workflow.id, corrected);
        persist(corrected);
      } else {
        this.workflows.set(workflow.id, workflow);
      }
    }
  }

  listWorkflowsForWorkspace(workspaceId: string): Workflow[] {
    return Array.from(this.workflows.values()).filter((w) => w.workspaceId === workspaceId);
  }

  submit(spec: WorkflowSpec): Workflow {
    if (spec.steps.length === 0) {
      throw new Error("A workflow requires at least one step");
    }

    const now = new Date().toISOString();
    const steps: WorkflowStepState[] = spec.steps.map(stepState);

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
    persist(workflow);
    eventBus.emit("workflow.created", { workflow });
    eventBus.emit("workflow.updated", { workflow });

    // Fire and forget - the whole step sequence runs async; updates flow
    // out via workflow.* events, same pattern as Job Engine / orchestrator.
    this.start(workflow.id, 0);

    return workflow;
  }

  /**
   * Continues a failed workflow from the first step that didn't complete. That
   * step starts over - a parallel group re-runs only the branches that hadn't
   * completed - and everything after it is reset. Returns the workflow, or why it
   * can't be resumed (it doesn't exist, or it isn't in the failed state).
   */
  resume(id: string): { workflow: Workflow } | { error: "not_found" | "not_resumable" } {
    const existing = this.workflows.get(id);
    if (!existing) return { error: "not_found" };
    if (existing.status !== "failed") return { error: "not_resumable" };

    const index = existing.steps.findIndex((s) => s.status !== "completed");
    if (index === -1) return { error: "not_resumable" };

    const fresh = (s: WorkflowBranchState): WorkflowBranchState => ({
      ...s,
      status: "pending",
      jobId: undefined,
      result: undefined,
      error: undefined,
    });
    const steps = existing.steps.map((step, i) => {
      if (i < index) return step;
      const reset = fresh(step) as WorkflowStepState;
      if (!step.branches) return reset;
      // Branches that finished keep their results; the rest start over.
      const branches = step.branches.map((b) =>
        b.status === "completed" && i === index ? b : fresh(b),
      );
      return { ...reset, branches };
    });

    const updated = this.update(id, {
      steps,
      status: "queued",
      error: undefined,
      currentStepIndex: index,
      resumeCount: (existing.resumeCount ?? 0) + 1,
    });
    if (!updated) return { error: "not_found" };
    this.start(id, index);
    return { workflow: updated };
  }

  private update(id: string, patch: Partial<Workflow>): Workflow | undefined {
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    const updated = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(id, updated);
    persist(updated);

    eventBus.emit("workflow.updated", { workflow: updated });
    if (updated.status === "completed") eventBus.emit("workflow.completed", { workflow: updated });
    if (updated.status === "failed") eventBus.emit("workflow.failed", { workflow: updated });

    return updated;
  }

  private updateStep(
    id: string,
    index: number,
    patch: Partial<WorkflowStepState>,
  ): Workflow | undefined {
    const existing = this.workflows.get(id);
    if (!existing) return undefined;
    const steps = existing.steps.slice();
    steps[index] = { ...steps[index], ...patch };
    return this.update(id, { steps });
  }

  private updateBranch(
    id: string,
    index: number,
    branch: number,
    patch: Partial<WorkflowBranchState>,
  ): Workflow | undefined {
    const existing = this.workflows.get(id);
    const branches = existing?.steps[index]?.branches?.slice();
    if (!branches) return undefined;
    branches[branch] = { ...branches[branch], ...patch };
    return this.updateStep(id, index, { branches });
  }

  /** Runs from `index` on; if the engine itself throws, the workflow fails instead of hanging. */
  private start(workflowId: string, index: number) {
    void this.runStep(workflowId, index).catch((err) => {
      const at = this.workflows.get(workflowId)?.currentStepIndex ?? index;
      const reason = err instanceof Error ? err.message : String(err);
      this.update(workflowId, {
        status: "failed",
        error: `The workflow engine stopped at step ${at}: ${reason}`,
      });
    });
  }

  /**
   * Resolves with the job once it is completed or failed. Fast-failing jobs
   * (e.g. immediate validation errors) can reach a terminal state before
   * submit() even returns - the Job Engine's own map is authoritative and
   * synchronous to read, so check it before subscribing rather than assuming
   * the event will be caught live (and so no listener is left behind). Same
   * defensive pattern the Job Engine uses against the orchestrator.
   */
  private settle(jobId: string): Promise<Job> {
    return new Promise((resolve) => {
      const already = jobEngine.getJob(jobId);
      if (already && isTerminal(already)) {
        resolve(already);
        return;
      }
      const onJobUpdate = (payload: EventMap["job.updated"]) => {
        if (payload.job.id !== jobId) return; // not this one's job
        if (!isTerminal(payload.job)) return;
        eventBus.off("job.updated", onJobUpdate);
        resolve(payload.job);
      };
      eventBus.on("job.updated", onJobUpdate);
    });
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
    this.update(workflowId, { status: "running", currentStepIndex: index });

    const advanced = step.branches
      ? await this.runGroup(workflowId, index, step, previous)
      : await this.runSingle(workflowId, index, step, previous);
    if (advanced) await this.runStep(workflowId, index + 1);
  }

  private async runSingle(
    workflowId: string,
    index: number,
    step: WorkflowStepState,
    previous: WorkflowStepState | undefined,
  ): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;

    const payload = payloadFor(step, previous);
    this.updateStep(workflowId, index, { status: "queued", payload });

    const job = jobEngine.submit({
      workspaceId: workflow.workspaceId,
      agent: step.agent,
      operation: step.operation,
      payload,
      maxAttempts: step.maxAttempts,
    });
    this.updateStep(workflowId, index, { jobId: job.id, status: "running" });

    const done = await this.settle(job.id);
    if (done.status === "completed") {
      this.updateStep(workflowId, index, {
        status: "completed",
        result: done.result,
        error: undefined,
      });
      return true;
    }
    this.updateStep(workflowId, index, { status: "failed", error: done.error });
    this.update(workflowId, {
      status: "failed",
      error: `Step ${index} ("${step.agent}:${step.operation}") failed: ${done.error}`,
    });
    return false;
  }

  private async runGroup(
    workflowId: string,
    index: number,
    step: WorkflowStepState,
    previous: WorkflowStepState | undefined,
  ): Promise<boolean> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || !step.branches) return false;
    this.updateStep(workflowId, index, { status: "running" });

    await Promise.all(
      step.branches.map(async (branch, b) => {
        if (branch.status === "completed") return; // finished before a resume
        const payload = payloadFor(branch, previous);
        this.updateBranch(workflowId, index, b, {
          status: "queued",
          payload,
          jobId: undefined,
          result: undefined,
          error: undefined,
        });
        const job = jobEngine.submit({
          workspaceId: workflow.workspaceId,
          agent: branch.agent,
          operation: branch.operation,
          payload,
          maxAttempts: branch.maxAttempts,
        });
        this.updateBranch(workflowId, index, b, { jobId: job.id, status: "running" });

        const done = await this.settle(job.id);
        if (done.status === "completed") {
          this.updateBranch(workflowId, index, b, { status: "completed", result: done.result });
        } else {
          this.updateBranch(workflowId, index, b, { status: "failed", error: done.error });
        }
      }),
    );

    const settled = this.workflows.get(workflowId)?.steps[index]?.branches ?? [];
    const failures = settled
      .map((branch, b) => ({ b, branch }))
      .filter(({ branch }) => branch.status === "failed");
    const result = {
      results: settled.map((branch) => (branch.status === "completed" ? branch.result : null)),
      failed: failures.length,
      ...(failures.length > 0
        ? { errors: failures.map(({ b, branch }) => ({ branch: b, error: branch.error })) }
        : {}),
    };

    if (failures.length > 0 && !step.continueOnError) {
      const which = failures
        .map(({ b, branch }) => {
          return `branch ${b} ("${branch.agent}:${branch.operation}"): ${branch.error}`;
        })
        .join("; ");
      this.updateStep(workflowId, index, { status: "failed", result, error: which });
      this.update(workflowId, {
        status: "failed",
        error: `Step ${index} (parallel) failed: ${which}`,
      });
      return false;
    }
    this.updateStep(workflowId, index, { status: "completed", result, error: undefined });
    return true;
  }
}

export const workflowEngine = new WorkflowEngine();
