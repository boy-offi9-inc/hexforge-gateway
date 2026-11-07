import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Same approach as the other route tests: a bare Fastify instance with only the
// route plugin, and the workflow engine and workspace service mocked, so this tests
// the routes' own job - validating steps (including parallel groups) and mapping
// resume outcomes to status codes - not the engine (workflow-engine.test.ts does that).
const workflow = { id: "wf1", workspaceId: "ws1", name: "demo", status: "queued", steps: [] };

async function buildApp() {
  vi.resetModules();
  const engine = {
    submit: vi.fn().mockReturnValue(workflow),
    getWorkflow: vi.fn(),
    listWorkflowsForWorkspace: vi.fn().mockReturnValue([]),
    resume: vi.fn().mockReturnValue({ workflow }),
  };
  vi.doMock("../src/modules/workspace/workspace.service.js", () => ({
    getWorkspace: vi.fn().mockResolvedValue({ id: "ws1" }),
  }));
  vi.doMock("../src/modules/workflow/workflow-engine.js", () => ({ workflowEngine: engine }));

  const { workflowRoutes } = await import("../src/api/v1/workflow.routes.js");
  const app = Fastify();
  await app.register(workflowRoutes);
  return { app, engine };
}

const post = (app: Awaited<ReturnType<typeof buildApp>>["app"], steps: unknown[]) =>
  app.inject({
    method: "POST",
    url: "/workspaces/ws1/workflows",
    payload: { name: "demo", steps },
  });

const decompile = { agent: "jadx", operation: "decompile" };
const search = { agent: "filesystem", operation: "search" };

describe("POST /workspaces/:id/workflows with parallel steps", () => {
  it("accepts a parallel group among plain steps and passes it on as given", async () => {
    const { app, engine } = await buildApp();
    const steps = [decompile, { parallel: [search, decompile], continueOnError: true }];

    const res = await post(app, steps);

    expect(res.statusCode).toBe(202);
    expect(engine.submit).toHaveBeenCalledWith({ workspaceId: "ws1", name: "demo", steps });
  });

  it("rejects a group with fewer than two branches or more than twenty", async () => {
    const { app, engine } = await buildApp();

    expect((await post(app, [{ parallel: [decompile] }])).statusCode).toBe(400);
    const tooMany = Array.from({ length: 21 }, () => decompile);
    expect((await post(app, [{ parallel: tooMany }])).statusCode).toBe(400);
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it("rejects a branch that is itself a group, or isn't a valid step", async () => {
    const { app } = await buildApp();

    const nested = { parallel: [decompile, { parallel: [search, search] }] };
    expect((await post(app, [nested])).statusCode).toBe(400);
    expect((await post(app, [{ parallel: [decompile, { operation: "x" }] }])).statusCode).toBe(400);
  });

  it("rejects a step that is both a group and a plain step, and says which one", async () => {
    const { app, engine } = await buildApp();

    const res = await post(app, [decompile, { ...search, parallel: [decompile, decompile] }]);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Step 1 has both "parallel" and "agent"/"operation"');
    expect(engine.submit).not.toHaveBeenCalled();
  });

  it("still takes ordinary sequential steps exactly as before", async () => {
    const { app, engine } = await buildApp();

    const res = await post(app, [decompile, { ...search, mergePreviousResult: true }]);

    expect(res.statusCode).toBe(202);
    expect(engine.submit).toHaveBeenCalledTimes(1);
  });
});

describe("POST /workflows/:workflowId/resume", () => {
  it("resumes a failed workflow and answers 202 with it", async () => {
    const { app, engine } = await buildApp();

    const res = await app.inject({ method: "POST", url: "/workflows/wf1/resume" });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ id: "wf1" });
    expect(engine.resume).toHaveBeenCalledWith("wf1");
  });

  it("answers 404 for an unknown workflow and 409 for one that isn't failed", async () => {
    const { app, engine } = await buildApp();

    engine.resume.mockReturnValueOnce({ error: "not_found" });
    const missing = await app.inject({ method: "POST", url: "/workflows/nope/resume" });
    expect(missing.statusCode).toBe(404);

    engine.resume.mockReturnValueOnce({ error: "not_resumable" });
    const conflict = await app.inject({ method: "POST", url: "/workflows/wf1/resume" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toContain("Only a failed workflow can be resumed");
  });
});
