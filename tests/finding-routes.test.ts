import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Same approach as artifact-routes.test.ts: a bare Fastify instance with only
// the route plugin and the two services it calls mocked. EvidenceError is the
// real class (importActual), because the routes decide 400 vs rethrow with
// instanceof.
const finding = {
  id: "f1",
  workspaceId: "ws1",
  claim: "Hardcoded API key",
  status: "unverified",
  evidence: [],
  source: "user",
  createdAt: "1",
  updatedAt: "1",
};

async function buildApp(opts: { workspaceExists?: boolean } = {}) {
  vi.resetModules();
  const real = await vi.importActual<typeof import("../src/findings/finding.service.js")>(
    "../src/findings/finding.service.js",
  );
  const service = {
    EvidenceError: real.EvidenceError,
    createFinding: vi.fn().mockResolvedValue(finding),
    listFindingsForWorkspace: vi.fn().mockResolvedValue([finding]),
    getFinding: vi.fn().mockImplementation(async (id: string) => (id === "f1" ? finding : null)),
    updateFinding: vi.fn().mockImplementation(async (id: string) => (id === "f1" ? finding : null)),
  };
  const workspaces = {
    getWorkspace: vi.fn().mockResolvedValue(opts.workspaceExists === false ? null : { id: "ws1" }),
  };
  vi.doMock("../src/modules/workspace/workspace.service.js", () => workspaces);
  vi.doMock("../src/findings/finding.service.js", () => service);

  const { findingRoutes } = await import("../src/api/v1/finding.routes.js");
  const app = Fastify();
  await app.register(findingRoutes);
  return { app, service };
}

describe("finding routes", () => {
  it("POST /workspaces/:id/findings creates (201) and passes the body through", async () => {
    const { app, service } = await buildApp();
    const body = { claim: "Hardcoded API key", evidence: [{ artifactId: "ar1" }] };
    const res = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/findings",
      payload: body,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(finding);
    expect(service.createFinding).toHaveBeenCalledWith({ workspaceId: "ws1", ...body });
  });

  it("POST validates the body, the workspace, and the evidence", async () => {
    const { app, service } = await buildApp();
    const bad = await app.inject({ method: "POST", url: "/workspaces/ws1/findings", payload: {} });
    expect(bad.statusCode).toBe(400);

    service.createFinding.mockRejectedValueOnce(new service.EvidenceError("bad evidence"));
    const evidence = await app.inject({
      method: "POST",
      url: "/workspaces/ws1/findings",
      payload: { claim: "x", evidence: [{ artifactId: "nope" }] },
    });
    expect(evidence.statusCode).toBe(400);
    expect(evidence.json()).toEqual({ error: "bad evidence" });

    const missing = await buildApp({ workspaceExists: false });
    const res404 = await missing.app.inject({
      method: "POST",
      url: "/workspaces/nope/findings",
      payload: { claim: "x" },
    });
    expect(res404.statusCode).toBe(404);
  });

  it("GET /workspaces/:id/findings filters by status and rejects a bad one", async () => {
    const { app, service } = await buildApp();
    const ok = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/findings?status=confirmed",
    });
    expect(ok.statusCode).toBe(200);
    expect(service.listFindingsForWorkspace).toHaveBeenCalledWith("ws1", "confirmed");

    const bad = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/findings?status=maybe",
    });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /findings/:findingId returns the finding or 404", async () => {
    const { app } = await buildApp();
    expect((await app.inject({ method: "GET", url: "/findings/f1" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/findings/zzz" })).statusCode).toBe(404);
  });

  it("PATCH /findings/:findingId updates, 404s, and maps evidence errors", async () => {
    const { app, service } = await buildApp();
    const ok = await app.inject({
      method: "PATCH",
      url: "/findings/f1",
      payload: { status: "contradicted" },
    });
    expect(ok.statusCode).toBe(200);
    expect(service.updateFinding).toHaveBeenCalledWith("f1", { status: "contradicted" });

    const missing = await app.inject({
      method: "PATCH",
      url: "/findings/zzz",
      payload: { status: "contradicted" },
    });
    expect(missing.statusCode).toBe(404);

    service.updateFinding.mockRejectedValueOnce(new service.EvidenceError("needs evidence"));
    const evidence = await app.inject({
      method: "PATCH",
      url: "/findings/f1",
      payload: { status: "confirmed" },
    });
    expect(evidence.statusCode).toBe(400);

    const empty = await app.inject({ method: "PATCH", url: "/findings/f1", payload: {} });
    expect(empty.statusCode).toBe(400);
  });
});
