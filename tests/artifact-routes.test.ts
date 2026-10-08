import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Same approach as api-routes.test.ts: a bare Fastify instance with only the
// route plugin, the two services it calls mocked one layer down, driven
// through app.inject().
const artifact = {
  id: "ar1",
  workspaceId: "ws1",
  kind: "java-sources",
  path: "/ws/ws1/jadx",
  pathType: "directory",
  source: { taskId: "t1", agent: "jadx", operation: "decompile", capability: "java.decompile" },
  createdAt: "1",
  updatedAt: "1",
};

async function buildApp(opts: { workspaceExists?: boolean } = {}) {
  vi.resetModules();
  const workspaces = {
    getWorkspace: vi.fn().mockResolvedValue(opts.workspaceExists === false ? null : { id: "ws1" }),
  };
  const artifacts = {
    listArtifactsForWorkspace: vi.fn().mockResolvedValue([artifact]),
    getArtifact: vi.fn().mockImplementation(async (id: string) => (id === "ar1" ? artifact : null)),
  };
  vi.doMock("../src/modules/workspace/workspace.service.js", () => workspaces);
  vi.doMock("../src/artifacts/artifact.service.js", () => artifacts);

  const { artifactRoutes } = await import("../src/api/v1/artifact.routes.js");
  const app = Fastify();
  await app.register(artifactRoutes);
  return { app, artifacts };
}

describe("artifact routes", () => {
  it("GET /workspaces/:id/artifacts lists and passes the kind filter through", async () => {
    const { app, artifacts } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/workspaces/ws1/artifacts?kind=apk" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([artifact]);
    expect(artifacts.listArtifactsForWorkspace).toHaveBeenCalledWith("ws1", "apk");
  });

  it("returns 404 for an unknown workspace and 400 for an empty kind", async () => {
    const missing = await buildApp({ workspaceExists: false });
    const res404 = await missing.app.inject({ method: "GET", url: "/workspaces/nope/artifacts" });
    expect(res404.statusCode).toBe(404);

    const { app } = await buildApp();
    const res400 = await app.inject({ method: "GET", url: "/workspaces/ws1/artifacts?kind=" });
    expect(res400.statusCode).toBe(400);
  });

  it("GET /artifacts/:artifactId returns the artifact or 404", async () => {
    const { app } = await buildApp();
    const ok = await app.inject({ method: "GET", url: "/artifacts/ar1" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual(artifact);

    const missing = await app.inject({ method: "GET", url: "/artifacts/zzz" });
    expect(missing.statusCode).toBe(404);
  });
});
