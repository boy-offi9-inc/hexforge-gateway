import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "../src/core/types.js";

// WorkflowEngine only ever talks to the Job Engine through jobEngine.submit()
// / jobEngine.getJob() - retries within a step are already the Job Engine's
// responsibility (see job-engine.test.ts), so mocking it here keeps these
// tests focused on step sequencing, result-merging, and stop-on-failure.
vi.mock("../src/modules/jobs/job-engine.js", () => ({
  jobEngine: {
    submit: vi.fn(),
    getJob: vi.fn(),
  },
}));
vi.mock("../src/modules/workflow/workflow.service.js", () => ({
  persistWorkflow: vi.fn().mockResolvedValue(undefined),
  listAllWorkflows: vi.fn().mockResolvedValue([]),
}));

import { jobEngine } from "../src/modules/jobs/job-engine.js";
import { workflowEngine } from "../src/modules/workflow/workflow-engine.js";
import { eventBus } from "../src/events/event-bus.js";

const submit = jobEngine.submit as ReturnType<typeof vi.fn>;
const getJob = jobEngine.getJob as ReturnType<typeof vi.fn>;

function makeJob(overrides: Partial<Job> & { id: string }): Job {
  const now = new Date().toISOString();
  return {
    workspaceId: "ws1",
    agent: "jadx",
    operation: "decompile",
    payload: {},
    status: "queued",
    attempts: 0,
    maxAttempts: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  submit.mockReset();
  getJob.mockReset().mockReturnValue(undefined);
});

// See job-engine.test.ts for why there's deliberately no
// afterEach(() => vi.restoreAllMocks()) here - it would strip
// persistWorkflow/listAllWorkflows back to a no-op vi.fn() after the
// first test, crashing every test after it the moment WorkflowEngine
// calls workflowService.persistWorkflow(workflow).catch(...).

describe("WorkflowEngine", () => {
  it("runs every step to completion, merging the previous step's result into the next payload", async () => {
    submit
      .mockReturnValueOnce(makeJob({ id: "job-1" }))
      .mockReturnValueOnce(makeJob({ id: "job-2" }));

    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Analyze APK",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        {
          agent: "filesystem",
          operation: "search",
          payload: { pattern: "TODO" },
          mergePreviousResult: true,
        },
      ],
    });

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.steps[0].jobId).toBe(
        "job-1",
      ),
    );
    eventBus.emit("job.updated", {
      job: {
        ...makeJob({ id: "job-1" }),
        status: "completed",
        result: { outputDir: "/ws/out" },
      },
    });

    // Step 2 should be dispatched with its own payload plus step 1's
    // result merged in, since mergePreviousResult is true.
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        payload: { pattern: "TODO", outputDir: "/ws/out" },
      }),
    );

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.steps[1].jobId).toBe(
        "job-2",
      ),
    );
    eventBus.emit("job.updated", {
      job: {
        ...makeJob({ id: "job-2" }),
        status: "completed",
        result: { hits: 3 },
      },
    });

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("completed"),
    );
    const finished = workflowEngine.getWorkflow(workflow.id)!;
    expect(finished.steps.map((s) => s.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(finished.steps[1].result).toEqual({ hits: 3 });
  });

  it("stops the whole workflow when a step fails, and never dispatches later steps", async () => {
    submit.mockReturnValueOnce(makeJob({ id: "job-1" }));

    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Analyze APK",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        { agent: "filesystem", operation: "search", payload: {} },
        { agent: "ai", operation: "summarize", payload: {} },
      ],
    });

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.steps[0].jobId).toBe(
        "job-1",
      ),
    );
    eventBus.emit("job.updated", {
      job: {
        ...makeJob({ id: "job-1" }),
        status: "failed",
        error: "jadx blew up",
      },
    });

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("failed"),
    );

    const finished = workflowEngine.getWorkflow(workflow.id)!;
    expect(finished.steps.map((s) => s.status)).toEqual([
      "failed",
      "pending",
      "pending",
    ]);
    expect(finished.error).toContain("jadx blew up");
    expect(submit).toHaveBeenCalledTimes(1); // steps 2 and 3 never dispatched
  });

  it("advances past a step whose job is already terminal by the time submit() returns, without a stray listener double-firing", async () => {
    const job1 = makeJob({
      id: "job-fast",
      status: "completed",
      result: { ok: true },
    });
    submit
      .mockReturnValueOnce(makeJob({ id: "job-fast" }))
      .mockReturnValueOnce(makeJob({ id: "job-2" }));
    getJob.mockImplementation((id: string) =>
      id === "job-fast" ? job1 : undefined,
    );

    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Two steps",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        { agent: "filesystem", operation: "search", payload: {} },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.steps[0].status).toBe(
        "completed",
      ),
    );

    // A stray duplicate event for the already-resolved first job should
    // have no listener left to react to it.
    eventBus.emit("job.updated", {
      job: { ...job1, status: "failed", error: "should be ignored" },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(workflowEngine.getWorkflow(workflow.id)?.steps[0].status).toBe(
      "completed",
    );
    expect(submit).toHaveBeenCalledTimes(2); // never re-dispatched step 1
  });
});
