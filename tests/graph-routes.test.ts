import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Same approach as finding-routes.test.ts: a bare Fastify instance with only
// the route plugin and the two services it calls mocked. GraphError is the
// real class (importActual), because the routes decide 400 vs rethrow with
// instanceof.
const entity = {
  id: "e1",
  workspaceId: "ws1",
  type: "class",
  name: "com.acme.Login",
  attributes: {},
  artifactIds: [],
  createdAt: "1",
  updatedAt: "1",
};
const edge = {
  id: "g1",
  workspaceId: "ws1",
  from: "e1",
  to: "e2",
  relation: "calls",
  createdAt: "1",
};

async function buildApp(opts: { workspaceExists?: boolean } = {}) {
  vi.resetModules();
  const real = await vi.importActual<typeof import("../src/graph/graph.service.js")>(
    "../src/graph/graph.service.js",
  );
  const service = {
    GraphError: real.GraphError,
    upsertEntity: vi.fn().mockResolvedValue({ entity, created: true }),
    listEntities: vi.fn().mockResolvedValue([entity]),
    getEntityWithEdges: vi
      .fn()
      .mockImplementation(async (id: string) => (id === "e1" ? { entity, edges: [edge] } : null)),
    addEdge: vi.fn().mockResolvedValue({ edge, created: true }),
    listEdges: vi.fn().mockResolvedValue([edge]),
  };
  const workspaces = {
    getWorkspace: vi.fn().mockResolvedValue(opts.workspaceExists === false ? null : { id: "ws1" }),
  };
  vi.doMock("../src/modules/workspace/workspace.service.js", () => workspaces);
  vi.doMock("../src/graph/graph.service.js", () => service);

  const { graphRoutes } = await import("../src/api/v1/graph.routes.js");
  const app = Fastify();
  await app.register(graphRoutes);
  return { app, service };
}

describe("graph routes", () => {
  it("POST entities returns 201 when created and 200 when merged", async () => {
    const { app, service } = await buildApp();
    const url = "/workspaces/ws1/graph/entities";
    const payload = { type: "class", name: "com.acme.Login", attributes: { lines: 12 } };

    const created = await app.inject({ method: "POST", url, payload });
    expect(created.statusCode).toBe(201);
    expect(service.upsertEntity).toHaveBeenCalledWith({ workspaceId: "ws1", ...payload });

    service.upsertEntity.mockResolvedValueOnce({ entity, created: false });
    const merged = await app.inject({ method: "POST", url, payload });
    expect(merged.statusCode).toBe(200);
    expect(merged.json()).toEqual(entity);
  });

  it("POST entities validates the body, the workspace and the artifact references", async () => {
    const { app, service } = await buildApp();
    const url = "/workspaces/ws1/graph/entities";

    const badType = await app.inject({ method: "POST", url, payload: { type: "dog", name: "x" } });
    expect(badType.statusCode).toBe(400);
    const badAttr = await app.inject({
      method: "POST",
      url,
      payload: { type: "class", name: "x", attributes: { nested: { no: 1 } } },
    });
    expect(badAttr.statusCode).toBe(400);

    service.upsertEntity.mockRejectedValueOnce(new service.GraphError("unknown artifact"));
    const refs = await app.inject({
      method: "POST",
      url,
      payload: { type: "class", name: "x", artifactIds: ["nope"] },
    });
    expect(refs.statusCode).toBe(400);
    expect(refs.json()).toEqual({ error: "unknown artifact" });

    const missing = await buildApp({ workspaceExists: false });
    const res404 = await missing.app.inject({
      method: "POST",
      url: "/workspaces/nope/graph/entities",
      payload: { type: "class", name: "x" },
    });
    expect(res404.statusCode).toBe(404);
  });

  it("GET entities passes the type and q filters through and rejects a bad type", async () => {
    const { app, service } = await buildApp();
    const ok = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/graph/entities?type=class&q=login",
    });
    expect(ok.statusCode).toBe(200);
    expect(service.listEntities).toHaveBeenCalledWith("ws1", { type: "class", q: "login" });

    const bad = await app.inject({ method: "GET", url: "/workspaces/ws1/graph/entities?type=dog" });
    expect(bad.statusCode).toBe(400);
  });

  it("GET /graph/entities/:entityId returns the entity with its edges, or 404", async () => {
    const { app } = await buildApp();
    const ok = await app.inject({ method: "GET", url: "/graph/entities/e1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ entity, edges: [edge] });

    const missing = await app.inject({ method: "GET", url: "/graph/entities/zzz" });
    expect(missing.statusCode).toBe(404);
  });

  it("POST edges returns 201 or 200, and maps graph errors to 400", async () => {
    const { app, service } = await buildApp();
    const url = "/workspaces/ws1/graph/edges";
    const payload = { from: "e1", to: "e2", relation: "calls" };

    const created = await app.inject({ method: "POST", url, payload });
    expect(created.statusCode).toBe(201);
    expect(service.addEdge).toHaveBeenCalledWith({ workspaceId: "ws1", ...payload });

    service.addEdge.mockResolvedValueOnce({ edge, created: false });
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(200);

    service.addEdge.mockRejectedValueOnce(new service.GraphError("Entity not found"));
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(400);

    const badRelation = await app.inject({
      method: "POST",
      url,
      payload: { from: "e1", to: "e2", relation: "likes" },
    });
    expect(badRelation.statusCode).toBe(400);
  });

  it("GET edges passes the entityId and relation filters through", async () => {
    const { app, service } = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/workspaces/ws1/graph/edges?entityId=e1&relation=calls",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([edge]);
    expect(service.listEdges).toHaveBeenCalledWith("ws1", { entityId: "e1", relation: "calls" });
  });
});
