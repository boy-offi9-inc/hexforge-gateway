import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, Workflow } from "../src/core/types.js";

// Same mocking setup as workflow-engine.test.ts / job-engine.test.ts: the
// engines are exercised against a mocked Job Engine / orchestrator so these
// tests focus on fan-out derivation and resume semantics.
vi.mock("../src/modules/jobs/job-engine.js", () => ({
  jobEngine: {
    submit: vi.fn(),
    getJob: vi.fn(),
    resume: vi.fn(),
  },
}));
vi.mock("../src/modules/workflow/workflow.service.js", () => ({
  persistWorkflow: vi.fn().mockResolvedValue(undefined),
  listAllWorkflows: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/modules/mcp/orchestrator.js", () => ({
  orchestrator: {
    dispatch: vi.fn(),
    getTask: vi.fn(),
  },
}));

import { jobEngine } from "../src/modules/jobs/job-engine.js";
import { orchestrator } from "../src/modules/mcp/orchestrator.js";
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

let counter = 0;
function autoJob(): Job {
  counter += 1;
  return makeJob({ id: `job-${counter}` });
}

beforeEach(() => {
  counter = 0;
  submit.mockReset().mockImplementation(autoJob);
  getJob.mockReset().mockReturnValue(undefined);
});

function completeJob(id: string, result: unknown) {
  eventBus.emit("job.updated", {
    job: { ...makeJob({ id }), status: "completed", result },
  });
}

describe("Phase 0: fan-out over a list of unknown length", () => {
  it("clones the template once per item of the previous result's list", async () => {
    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Fan out over found files",
      steps: [
        { agent: "filesystem", operation: "search", payload: {} },
        {
          fanOut: { agent: "jadx", operation: "decompile", payload: { mode: "full" } },
          from: "files",
        },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    completeJob("job-1", { files: ["/a.apk", "/b.apk", "/c.apk"] });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(4));
    for (let i = 1; i <= 3; i++) {
      completeJob(submit.mock.results[i].value.id, { ok: i });
    }

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("completed"),
    );
    // One dispatch per item, each with the item merged into the template payload.
    expect(submit).toHaveBeenCalledTimes(4);
    expect(submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agent: "jadx", payload: { mode: "full", item: "/a.apk" } }),
    );
    expect(submit).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ payload: { mode: "full", item: "/c.apk" } }),
    );
    const finished = workflowEngine.getWorkflow(workflow.id)!;
    expect(finished.steps[1].agent).toBe("fanout");
    expect(finished.steps[1].branches?.length).toBe(3);
    expect(finished.steps[1].result).toEqual({
      results: [{ ok: 1 }, { ok: 2 }, { ok: 3 }],
      failed: 0,
    });
  });

  it("merges object items into the template payload", async () => {
    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Fan out over objects",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        { fanOut: { agent: "filesystem", operation: "search", payload: { pattern: "x" } } },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    completeJob("job-1", [{ path: "/a" }, { path: "/b" }]);

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    for (let i = 1; i <= 2; i++) {
      completeJob(submit.mock.results[i].value.id, { ok: true });
    }

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("completed"),
    );
    // The array at the result root is the list; object items merge over the payload.
    expect(submit).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ payload: { pattern: "x", path: "/a" } }),
    );
    expect(submit).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ payload: { pattern: "x", path: "/b" } }),
    );
  });

  it("fails the workflow when the previous result has no list", async () => {
    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Fan out over nothing",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        { fanOut: { agent: "jadx", operation: "decompile" }, from: "nope" },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    completeJob("job-1", { outputDir: "/ws/out" });

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("failed"),
    );
    const finished = workflowEngine.getWorkflow(workflow.id)!;
    expect(finished.error).toContain('no list at "nope"');
    expect(submit).toHaveBeenCalledTimes(1); // nothing dispatched for the fan-out step
  });

  it("enforces the branch cap", async () => {
    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Too many",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        { fanOut: { agent: "jadx", operation: "decompile" }, maxBranches: 2 },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    completeJob("job-1", ["a", "b", "c"]);

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("failed"),
    );
    expect(workflowEngine.getWorkflow(workflow.id)?.error).toContain("over the cap of 2");
  });

  it("completes empty when the list is empty", async () => {
    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Empty list",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        { fanOut: { agent: "jadx", operation: "decompile" } },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    completeJob("job-1", []);

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("completed"),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    expect(workflowEngine.getWorkflow(workflow.id)?.steps[1].result).toEqual({
      results: [],
      failed: 0,
    });
  });

  it("honors continueOnError and still completes with failures recorded", async () => {
    const workflow = workflowEngine.submit({
      workspaceId: "ws1",
      name: "Fan out, keep going",
      steps: [
        { agent: "jadx", operation: "decompile", payload: {} },
        {
          fanOut: { agent: "jadx", operation: "decompile" },
          continueOnError: true,
        },
      ],
    });

    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    completeJob("job-1", ["a", "b"]);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(3));
    // First branch fails, second completes; the group completes anyway.
    eventBus.emit("job.updated", {
      job: {
        ...makeJob({ id: submit.mock.results[1].value.id }),
        status: "failed",
        error: "boom",
      },
    });
    completeJob(submit.mock.results[2].value.id, { ok: true });

    await vi.waitFor(() =>
      expect(workflowEngine.getWorkflow(workflow.id)?.status).toBe("completed"),
    );
    const finished = workflowEngine.getWorkflow(workflow.id)!;
    expect(finished.steps[1].result).toMatchObject({ failed: 1 });
  });
});

// The Job Engine module is mocked above (the Workflow Engine tests drive it
// through vi.fn()s); the resume tests need the real singleton, pulled past
// the mock with importActual at the module's top level.
const { jobEngine: realJobEngine } = await vi.importActual<
  typeof import("../src/modules/jobs/job-engine.js")
>("../src/modules/jobs/job-engine.js");

describe("Phase 0: resuming plain jobs", () => {
  it("resumes a failed job from the beginning and completes it", async () => {
    const dispatch = orchestrator.dispatch as ReturnType<typeof vi.fn>;
    const getTask = orchestrator.getTask as ReturnType<typeof vi.fn>;
    const task = {
      id: "t-1",
      workspaceId: "ws1",
      agent: "jadx",
      operation: "decompile",
      payload: {},
      status: "completed",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      result: { ok: true },
    };
    dispatch.mockResolvedValue({ ...task, status: "queued" });
    getTask.mockReturnValue(undefined);

    const job = realJobEngine.submit({
      workspaceId: "ws1",
      agent: "jadx",
      operation: "decompile",
      payload: {},
    });
    await vi.waitFor(() => expect(realJobEngine.getJob(job.id)?.status).toBe("running"));
    // Simulate the task failing (no retries left).
    eventBus.emit("mcp.task.updated", {
      task: { ...task, id: (realJobEngine.getJob(job.id)?.currentTaskId ?? task.id), status: "failed", error: "nope" },
    });
    await vi.waitFor(() => expect(realJobEngine.getJob(job.id)?.status).toBe("failed"));

    const outcome = realJobEngine.resume(job.id);
    expect("job" in outcome && outcome.job.status).toBe("queued");
    const resumed = "job" in outcome ? outcome.job : undefined;
    // The resumed attempt dispatches a fresh task; complete it.
    await vi.waitFor(() => {
      const current = realJobEngine.getJob(job.id)?.currentTaskId;
      expect(current).toBeTruthy();
      eventBus.emit("mcp.task.updated", {
        task: { ...task, id: current as string, status: "completed", result: { ok: true } },
      });
    });
    await vi.waitFor(() => expect(realJobEngine.getJob(job.id)?.status).toBe("completed"));
    expect(resumed?.attempts).toBe(0);
    expect(realJobEngine.getJob(job.id)?.attempts).toBe(1);
    expect(realJobEngine.getJob(job.id)?.result).toEqual({ ok: true });
    expect(realJobEngine.getJob(job.id)?.resumeCount).toBe(1);
  });

  it("refuses to resume a missing or non-failed job", () => {
    expect(realJobEngine.resume("missing")).toEqual({ error: "not_found" });
    const job = realJobEngine.submit({
      workspaceId: "ws1",
      agent: "jadx",
      operation: "decompile",
      payload: {},
    });
    expect(realJobEngine.resume(job.id)).toEqual({ error: "not_resumable" });
  });
});
