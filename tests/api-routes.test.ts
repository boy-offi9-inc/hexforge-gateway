import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// Route-level tests: a bare Fastify instance with just the route plugins
// registered (no websocket, auth, plugin loader, or knowledge indexer -
// buildServer() in core/server.ts wires all of that, none of it is what's
// under test here), driven through app.inject() so there's no real
// listening port. Every service the routes call is mocked one layer down,
// same approach as job-engine.test.ts - these tests only care that a
// route validates its input, returns the right status, and calls the
// right service with the right arguments, not what the services do.
//
// vi.doMock (not vi.mock) inside a helper, because the knowledge routes'
// 503 paths depend on ai.service's `isAiConfigured` being false, and that's
// a plain exported constant - the cleanest way to get both values is a
// fresh module graph per app, built with whichever value the test wants.

const workspace = {
  id: "ws1",
  name: "demo",
  targetLabel: "demo",
  status: "idle",
  createdAt: "",
  updatedAt: "",
};
const entry = {
  id: "kn1",
  workspaceId: "ws1",
  type: "note",
  title: "t",
  content: "c",
  source: "user",
  createdAt: "1",
  updatedAt: "1",
  relatedEntryIds: [],
};

async function buildApp(opts: { aiConfigured?: boolean } = {}) {
  const aiConfigured = opts.aiConfigured ?? true;
  vi.resetModules();

  const m = {
    workspace: {
      getWorkspace: vi.fn(),
      createWorkspace: vi.fn(),
      listWorkspaces: vi.fn(),
      getOrCreateWorkspace: vi.fn(),
      updateWorkspaceStatus: vi.fn(),
    },
    orchestrator: { dispatch: vi.fn(), listTasksForWorkspace: vi.fn() },
    inbox: { listInboxApks: vi.fn() },
    jobs: { submit: vi.fn(), listJobsForWorkspace: vi.fn(), getJob: vi.fn() },
    workflows: {
      submit: vi.fn(),
      listWorkflowsForWorkspace: vi.fn(),
      getWorkflow: vi.fn(),
    },
    knowledge: {
      createEntry: vi.fn(),
      listEntriesForWorkspace: vi.fn(),
      getEntry: vi.fn(),
      updateEntry: vi.fn(),
      deleteEntry: vi.fn(),
    },
    ai: { summarizeEntry: vi.fn(), chat: vi.fn() },
  };

  vi.doMock("../src/modules/workspace/workspace.service.js", () => m.workspace);
  vi.doMock("../src/modules/mcp/orchestrator.js", () => ({
    orchestrator: m.orchestrator,
  }));
  vi.doMock("../src/modules/inbox/inbox-watcher.js", () => m.inbox);
  vi.doMock("../src/modules/jobs/job-engine.js", () => ({ jobEngine: m.jobs }));
  vi.doMock("../src/modules/workflow/workflow-engine.js", () => ({
    workflowEngine: m.workflows,
  }));
  vi.doMock("../src/modules/knowledge/knowledge.service.js", () => m.knowledge);
  vi.doMock("../src/modules/ai/ai.service.js", () => ({
    isAiConfigured: aiConfigured,
    ...m.ai,
  }));
  vi.doMock("../src/core/config.js", () => ({
    config: { AI_PROVIDER: "anthropic", STORAGE_BACKEND: "local" },
    isSupabaseConfigured: false,
    isAiConfigured: aiConfigured,
    isAuthEffectivelyEnabled: false,
  }));

  const { default: Fastify } = await import("fastify");
  const app = Fastify();
  await app.register(
    (await import("../src/api/v1/health.routes.js")).healthRoutes,
  );
  await app.register(
    (await import("../src/api/v1/workspace.routes.js")).workspaceRoutes,
  );
  await app.register((await import("../src/api/v1/job.routes.js")).jobRoutes);
  await app.register(
    (await import("../src/api/v1/workflow.routes.js")).workflowRoutes,
  );
  await app.register(
    (await import("../src/api/v1/knowledge.routes.js")).knowledgeRoutes,
  );
  await app.ready();

  return { app, m };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /health", () => {
  it("reports status and config flags", async () => {
    const built = await buildApp({ aiConfigured: false });
    app = built.app;

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      storageBackend: "local",
      aiProvider: "anthropic",
      aiConfigured: false,
      authEnabled: false,
    });
  });
});

describe("workspace routes", () => {
  it("POST /workspaces creates a workspace from a valid body", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.createWorkspace.mockResolvedValue(workspace);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces",
      payload: { name: "demo", targetLabel: "demo" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(workspace);
    expect(m.workspace.createWorkspace).toHaveBeenCalledWith("demo", "demo");
  });

  it.each([
    ["a missing name", { targetLabel: "demo" }, "name"],
    ["an empty name", { name: "", targetLabel: "demo" }, "name"],
    ["a missing targetLabel", { name: "demo" }, "targetLabel"],
  ])(
    "POST /workspaces rejects %s with 400 and never touches the service",
    async (_label, payload, field) => {
      const { app: a, m } = await buildApp();
      app = a;

      const res = await app.inject({
        method: "POST",
        url: "/workspaces",
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.fieldErrors[field]).toBeDefined();
      expect(m.workspace.createWorkspace).not.toHaveBeenCalled();
    },
  );

  it("PUT /workspaces/by-name/:name with no body defaults targetLabel to the name", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getOrCreateWorkspace.mockResolvedValue(workspace);

    const res = await app.inject({
      method: "PUT",
      url: "/workspaces/by-name/clite-analysis",
    });

    expect(res.statusCode).toBe(200);
    expect(m.workspace.getOrCreateWorkspace).toHaveBeenCalledWith(
      "clite-analysis",
      "clite-analysis",
    );
  });

  it("PUT /workspaces/by-name/:name uses an explicit targetLabel when given", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getOrCreateWorkspace.mockResolvedValue(workspace);

    await app.inject({
      method: "PUT",
      url: "/workspaces/by-name/clite",
      payload: { targetLabel: "com.clite.dialer" },
    });

    expect(m.workspace.getOrCreateWorkspace).toHaveBeenCalledWith(
      "clite",
      "com.clite.dialer",
    );
  });

  it("PUT /workspaces/by-name/:name rejects an empty targetLabel", async () => {
    const { app: a, m } = await buildApp();
    app = a;

    const res = await app.inject({
      method: "PUT",
      url: "/workspaces/by-name/clite",
      payload: { targetLabel: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(m.workspace.getOrCreateWorkspace).not.toHaveBeenCalled();
  });

  it("GET /workspaces/:id returns 404 for an unknown workspace and the workspace otherwise", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(workspace);

    const missing = await app.inject({
      method: "GET",
      url: "/workspaces/nope",
    });
    const found = await app.inject({ method: "GET", url: "/workspaces/ws1" });

    expect(missing.statusCode).toBe(404);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toEqual(workspace);
  });

  describe("POST /workspaces/:id/tasks", () => {
    it("404s for an unknown workspace without dispatching anything", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/nope/tasks",
        payload: { agent: "jadx", operation: "decompile" },
      });

      expect(res.statusCode).toBe(404);
      expect(m.orchestrator.dispatch).not.toHaveBeenCalled();
    });

    it.each([
      ["a missing agent", { operation: "decompile" }],
      ["a missing operation", { agent: "jadx" }],
      [
        "a non-object payload",
        { agent: "jadx", operation: "decompile", payload: "not-an-object" },
      ],
    ])("rejects %s with 400 and never dispatches", async (_label, payload) => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/tasks",
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(m.orchestrator.dispatch).not.toHaveBeenCalled();
    });

    it("dispatches a valid task, marks the workspace analyzing, and returns 202", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);
      m.orchestrator.dispatch.mockResolvedValue({ id: "t1", status: "queued" });

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/tasks",
        payload: {
          agent: "jadx",
          operation: "decompile",
          payload: { apkPath: "/x.apk" },
        },
      });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ id: "t1", status: "queued" });
      expect(m.orchestrator.dispatch).toHaveBeenCalledWith({
        workspaceId: "ws1",
        agent: "jadx",
        operation: "decompile",
        payload: { apkPath: "/x.apk" },
      });
      expect(m.workspace.updateWorkspaceStatus).toHaveBeenCalledWith(
        "ws1",
        "analyzing",
      );
    });
  });

  it("GET /workspaces/:id/inbox 404s for an unknown workspace and wraps the list in { apks } otherwise", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    const apks = [
      {
        fileName: "app.apk",
        path: "/w/ws1/inbox/app.apk",
        sizeBytes: 1,
        detectedAt: "now",
      },
    ];
    m.workspace.getWorkspace
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(workspace);
    m.inbox.listInboxApks.mockResolvedValue(apks);

    const missing = await app.inject({
      method: "GET",
      url: "/workspaces/nope/inbox",
    });
    const found = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/inbox",
    });

    expect(missing.statusCode).toBe(404);
    expect(found.json()).toEqual({ apks });
  });
});

describe("job routes", () => {
  it("POST /workspaces/:id/jobs 404s for an unknown workspace", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/nope/jobs",
      payload: { agent: "jadx", operation: "decompile" },
    });

    expect(res.statusCode).toBe(404);
    expect(m.jobs.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["above the cap of 10", 11],
    ["a non-integer", 1.5],
    ["a string", "3"],
  ])("rejects maxAttempts that's %s with 400", async (_label, maxAttempts) => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/jobs",
      payload: { agent: "jadx", operation: "decompile", maxAttempts },
    });

    expect(res.statusCode).toBe(400);
    expect(m.jobs.submit).not.toHaveBeenCalled();
  });

  it("accepts maxAttempts at the cap and submits the job with 202", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);
    m.jobs.submit.mockReturnValue({ id: "j1", status: "queued" });

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/jobs",
      payload: {
        agent: "jadx",
        operation: "decompile",
        payload: { apkPath: "/x.apk" },
        maxAttempts: 10,
      },
    });

    expect(res.statusCode).toBe(202);
    expect(m.jobs.submit).toHaveBeenCalledWith({
      workspaceId: "ws1",
      agent: "jadx",
      operation: "decompile",
      payload: { apkPath: "/x.apk" },
      maxAttempts: 10,
    });
  });

  it("GET /jobs/:jobId 404s for an unknown job and returns it otherwise", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.jobs.getJob
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({ id: "j1", status: "completed" });

    const missing = await app.inject({ method: "GET", url: "/jobs/nope" });
    const found = await app.inject({ method: "GET", url: "/jobs/j1" });

    expect(missing.statusCode).toBe(404);
    expect(found.json()).toEqual({ id: "j1", status: "completed" });
  });
});

describe("workflow routes", () => {
  const step = { agent: "jadx", operation: "decompile" };

  it("POST /workspaces/:id/workflows 404s for an unknown workspace", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(undefined);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/nope/workflows",
      payload: { name: "w", steps: [step] },
    });

    expect(res.statusCode).toBe(404);
    expect(m.workflows.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing name", { steps: [step] }],
    ["an empty steps array", { name: "w", steps: [] }],
    ["a step missing its operation", { name: "w", steps: [{ agent: "jadx" }] }],
    [
      "a step with an out-of-range maxAttempts",
      { name: "w", steps: [{ ...step, maxAttempts: 11 }] },
    ],
    [
      "a step with a non-boolean mergePreviousResult",
      { name: "w", steps: [{ ...step, mergePreviousResult: "yes" }] },
    ],
  ])("rejects %s with 400 and never submits", async (_label, payload) => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/workflows",
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(m.workflows.submit).not.toHaveBeenCalled();
  });

  it("submits a valid workflow with 202", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);
    m.workflows.submit.mockReturnValue({ id: "wf1", status: "queued" });
    const steps = [
      step,
      { agent: "filesystem", operation: "search", mergePreviousResult: true },
    ];

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/workflows",
      payload: { name: "analyze", steps },
    });

    expect(res.statusCode).toBe(202);
    expect(m.workflows.submit).toHaveBeenCalledWith({
      workspaceId: "ws1",
      name: "analyze",
      steps,
    });
  });

  it("GET /workflows/:workflowId 404s for an unknown workflow", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workflows.getWorkflow.mockReturnValue(undefined);

    const res = await app.inject({ method: "GET", url: "/workflows/nope" });

    expect(res.statusCode).toBe(404);
  });
});

describe("knowledge routes", () => {
  it("POST /workspaces/:id/knowledge creates a user-sourced entry with 201", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);
    m.knowledge.createEntry.mockResolvedValue(entry);

    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/knowledge",
      payload: { type: "note", title: "t", content: "c" },
    });

    expect(res.statusCode).toBe(201);
    expect(m.knowledge.createEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        type: "note",
        source: "user",
      }),
    );
  });

  it.each([
    ["an unknown type", { type: "bogus", title: "t", content: "c" }],
    ["an empty title", { type: "note", title: "", content: "c" }],
    ["empty content", { type: "note", title: "t", content: "" }],
  ])(
    "POST /workspaces/:id/knowledge rejects %s with 400",
    async (_label, payload) => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/knowledge",
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(m.knowledge.createEntry).not.toHaveBeenCalled();
    },
  );

  it("GET /workspaces/:id/knowledge validates the ?type= filter and passes a valid one through", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);
    m.knowledge.listEntriesForWorkspace.mockResolvedValue([entry]);

    const bad = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/knowledge?type=bogus",
    });
    const good = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/knowledge?type=note",
    });

    expect(bad.statusCode).toBe(400);
    expect(good.statusCode).toBe(200);
    expect(m.knowledge.listEntriesForWorkspace).toHaveBeenCalledTimes(1);
    expect(m.knowledge.listEntriesForWorkspace).toHaveBeenCalledWith("ws1", {
      type: "note",
    });
  });

  describe("PATCH /knowledge/:entryId", () => {
    it("404s for an unknown entry without updating anything", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.knowledge.getEntry.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "PATCH",
        url: "/knowledge/nope",
        payload: { title: "new" },
      });

      expect(res.statusCode).toBe(404);
      expect(m.knowledge.updateEntry).not.toHaveBeenCalled();
    });

    it('rejects an empty update body (the "at least one field" refinement)', async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.knowledge.getEntry.mockResolvedValue(entry);

      const res = await app.inject({
        method: "PATCH",
        url: "/knowledge/kn1",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(m.knowledge.updateEntry).not.toHaveBeenCalled();
    });

    it("applies a valid partial update", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.knowledge.getEntry.mockResolvedValue(entry);
      m.knowledge.updateEntry.mockResolvedValue({ ...entry, title: "new" });

      const res = await app.inject({
        method: "PATCH",
        url: "/knowledge/kn1",
        payload: { title: "new" },
      });

      expect(res.statusCode).toBe(200);
      expect(m.knowledge.updateEntry).toHaveBeenCalledWith("kn1", {
        title: "new",
      });
    });
  });

  it("DELETE /knowledge/:entryId 404s for an unknown entry and returns 204 after deleting an existing one", async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.knowledge.getEntry
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(entry);

    const missing = await app.inject({
      method: "DELETE",
      url: "/knowledge/nope",
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/knowledge/kn1",
    });

    expect(missing.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(204);
    expect(m.knowledge.deleteEntry).toHaveBeenCalledOnce();
    expect(m.knowledge.deleteEntry).toHaveBeenCalledWith("kn1");
  });

  describe("POST /knowledge/:entryId/summarize", () => {
    it("404s for an unknown entry", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.knowledge.getEntry.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/knowledge/nope/summarize",
      });

      expect(res.statusCode).toBe(404);
    });

    it("503s, naming the provider, when the AI provider isn't configured - without calling it", async () => {
      const { app: a, m } = await buildApp({ aiConfigured: false });
      app = a;
      m.knowledge.getEntry.mockResolvedValue(entry);

      const res = await app.inject({
        method: "POST",
        url: "/knowledge/kn1/summarize",
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain('"anthropic"');
      expect(m.ai.summarizeEntry).not.toHaveBeenCalled();
    });

    it("502s with the provider's error message when summarizing throws", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.knowledge.getEntry.mockResolvedValue(entry);
      m.ai.summarizeEntry.mockRejectedValue(
        new Error("Anthropic API error (429): rate limited"),
      );

      const res = await app.inject({
        method: "POST",
        url: "/knowledge/kn1/summarize",
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain("rate limited");
    });

    it("returns the new summary entry with 201", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.knowledge.getEntry.mockResolvedValue(entry);
      m.ai.summarizeEntry.mockResolvedValue({
        ...entry,
        id: "kn2",
        type: "summary",
      });

      const res = await app.inject({
        method: "POST",
        url: "/knowledge/kn1/summarize",
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().type).toBe("summary");
    });
  });

  describe("POST /workspaces/:id/chat", () => {
    it("404s for an unknown workspace", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(undefined);

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/nope/chat",
        payload: { message: "hi" },
      });

      expect(res.statusCode).toBe(404);
    });

    it("503s when the AI provider isn't configured - checked before the body, so even an invalid body gets 503", async () => {
      const { app: a, m } = await buildApp({ aiConfigured: false });
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/chat",
        payload: {},
      });

      expect(res.statusCode).toBe(503);
      expect(m.ai.chat).not.toHaveBeenCalled();
    });

    it("rejects an empty message with 400", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/chat",
        payload: { message: "" },
      });

      expect(res.statusCode).toBe(400);
      expect(m.ai.chat).not.toHaveBeenCalled();
    });

    it("502s with the provider's error message when chat throws", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);
      m.ai.chat.mockRejectedValue(new Error("Could not reach Ollama"));

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/chat",
        payload: { message: "hi" },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain("Could not reach Ollama");
    });

    it("returns the reply with 201", async () => {
      const { app: a, m } = await buildApp();
      app = a;
      m.workspace.getWorkspace.mockResolvedValue(workspace);
      m.ai.chat.mockResolvedValue({ reply: "hello" });

      const res = await app.inject({
        method: "POST",
        url: "/workspaces/ws1/chat",
        payload: { message: "hi" },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ reply: "hello" });
      expect(m.ai.chat).toHaveBeenCalledWith("ws1", "hi");
    });
  });

  it('GET /workspaces/:id/chat returns the transcript oldest-first, mapping source "user" to role user and anything else to assistant', async () => {
    const { app: a, m } = await buildApp();
    app = a;
    m.workspace.getWorkspace.mockResolvedValue(workspace);
    // listEntriesForWorkspace is newest-first - the route has to reverse it.
    m.knowledge.listEntriesForWorkspace.mockResolvedValue([
      { ...entry, id: "b", source: "system", content: "reply", createdAt: "2" },
      { ...entry, id: "a", source: "user", content: "hi", createdAt: "1" },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/chat",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { role: "user", content: "hi", createdAt: "1" },
      { role: "assistant", content: "reply", createdAt: "2" },
    ]);
    expect(m.knowledge.listEntriesForWorkspace).toHaveBeenCalledWith("ws1", {
      type: "chat",
    });
  });
});
