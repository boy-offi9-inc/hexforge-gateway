import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTask } from "../src/core/types.js";

// JobEngine talks to the orchestrator and to job.service (persistence)
// purely through their exported functions, so mocking both modules lets
// these tests drive retry/failure logic without any real MCP agent, file
// I/O, or Supabase call - see docs/ROADMAP.md's "Real unit/integration
// tests" item, which specifically calls out retry/error paths as the gap
// scripts/smoke-test.sh doesn't cover.
vi.mock("../src/modules/mcp/orchestrator.js", () => ({
  orchestrator: {
    dispatch: vi.fn(),
    getTask: vi.fn(),
  },
}));
vi.mock("../src/modules/jobs/job.service.js", () => ({
  persistJob: vi.fn().mockResolvedValue(undefined),
  listAllJobs: vi.fn().mockResolvedValue([]),
}));

vi.mock("../src/modules/mcp/orchestrator.js", () => ({
  orchestrator: {
    dispatch: vi.fn(),
    getTask: vi.fn(),
  },
}));
vi.mock("../src/modules/jobs/job.service.js", () => ({
  persistJob: vi.fn().mockResolvedValue(undefined),
  listAllJobs: vi.fn().mockResolvedValue([]),
}));

// vi.mock calls above are hoisted above these imports by Vitest, so
// job-engine.js's own (transitive) import of orchestrator.js resolves to
// the mock too - this isn't two disconnected orchestrator instances.
import { orchestrator } from "../src/modules/mcp/orchestrator.js";
import { jobEngine } from "../src/modules/jobs/job-engine.js";
import { eventBus } from "../src/events/event-bus.js";

const dispatch = orchestrator.dispatch as ReturnType<typeof vi.fn>;
const getTask = orchestrator.getTask as ReturnType<typeof vi.fn>;

function makeTask(overrides: Partial<McpTask> & { id: string }): McpTask {
  const now = new Date().toISOString();
  return {
    workspaceId: "ws1",
    agent: "jadx",
    operation: "decompile",
    payload: {},
    status: "queued",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  dispatch.mockReset();
  // Default: "no, this task hasn't already settled" - individual tests
  // override this to exercise the fast-fail synchronous path.
  getTask.mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("JobEngine", () => {
  it("completes the job when its task succeeds on the first attempt", async () => {
    const task = makeTask({ id: "t-ok" });
    dispatch.mockResolvedValue(task);

    const job = jobEngine.submit({ workspaceId: "ws1", agent: "jadx", operation: "decompile", maxAttempts: 1 });

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.currentTaskId).toBe("t-ok"));

    eventBus.emit("mcp.task.updated", { task: { ...task, status: "completed", result: { ok: true } } });

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.status).toBe("completed"));

    const finished = jobEngine.getJob(job.id)!;
    expect(finished.result).toEqual({ ok: true });
    expect(finished.attempts).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retries a failed attempt and completes once a later attempt succeeds", async () => {
    const taskA = makeTask({ id: "t-attempt-1" });
    const taskB = makeTask({ id: "t-attempt-2" });
    dispatch.mockResolvedValueOnce(taskA).mockResolvedValueOnce(taskB);

    const job = jobEngine.submit({ workspaceId: "ws1", agent: "jadx", operation: "decompile", maxAttempts: 2 });

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.currentTaskId).toBe("t-attempt-1"));
    eventBus.emit("mcp.task.updated", { task: { ...taskA, status: "failed", error: "first try failed" } });

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.currentTaskId).toBe("t-attempt-2"));
    eventBus.emit("mcp.task.updated", { task: { ...taskB, status: "completed", result: { ok: true } } });

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.status).toBe("completed"));

    const finished = jobEngine.getJob(job.id)!;
    expect(finished.attempts).toBe(2);
    expect(finished.error).toBeUndefined();
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("fails once maxAttempts is exhausted, without retrying further", async () => {
    let callIndex = 0;
    dispatch.mockImplementation(async () => makeTask({ id: `t-${++callIndex}` }));

    const job = jobEngine.submit({ workspaceId: "ws1", agent: "jadx", operation: "decompile", maxAttempts: 3 });

    for (let attempt = 1; attempt <= 3; attempt++) {
      await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.currentTaskId).toBe(`t-${attempt}`));
      eventBus.emit("mcp.task.updated", {
        task: makeTask({ id: `t-${attempt}`, status: "failed", error: `attempt ${attempt} failed` }),
      });
    }

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.status).toBe("failed"));

    const finished = jobEngine.getJob(job.id)!;
    expect(finished.attempts).toBe(3);
    expect(finished.error).toBe("attempt 3 failed");
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it("handles a task that's already terminal by the time dispatch() resolves, without a stray listener double-firing later", async () => {
    // Regression test for the race fixed earlier: a fast-failing task can
    // reach a terminal state (in the orchestrator's own map) before
    // runAttempt finishes awaiting dispatch(). getTask() returning that
    // already-failed task should resolve the job synchronously, *without*
    // ever registering an mcp.task.updated listener for it.
    const task = makeTask({ id: "t-fast-fail" });
    dispatch.mockResolvedValue(task);
    getTask.mockImplementation((id: string) =>
      id === "t-fast-fail" ? { ...task, status: "failed", error: "blew up immediately" } : undefined
    );

    const job = jobEngine.submit({ workspaceId: "ws1", agent: "jadx", operation: "decompile", maxAttempts: 1 });

    await vi.waitFor(() => expect(jobEngine.getJob(job.id)?.status).toBe("failed"));
    expect(jobEngine.getJob(job.id)?.error).toBe("blew up immediately");
    expect(dispatch).toHaveBeenCalledTimes(1);

    // If a listener for this task had incorrectly stayed registered, this
    // stray "completed" event would flip the job back - it shouldn't.
    eventBus.emit("mcp.task.updated", { task: { ...task, status: "completed", result: { ok: true } } });
    await new Promise((resolve) => setImmediate(resolve));

    const finished = jobEngine.getJob(job.id)!;
    expect(finished.status).toBe("failed");
    expect(finished.result).toBeUndefined();
  });
});
