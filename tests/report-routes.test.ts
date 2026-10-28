import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

// Same approach as finding-routes.test.ts: a bare Fastify instance with only
// the route plugin, the workspace service and the report builder mocked, so
// this tests the route's own job - parsing the query, choosing the renderer,
// setting the content type - not the report's content (report-builder and
// report-renderers cover that).
const report = {
  generatedAt: "now",
  workspace: { id: "ws1", name: "demo", targetLabel: "com.acme.app" },
  filter: { verified: true },
  summary: {
    findings: 0,
    byStatus: { confirmed: 0, unverified: 0, contradicted: 0 },
  },
  findings: [],
};

async function buildApp(opts: { workspaceExists?: boolean } = {}) {
  vi.resetModules();
  const builder = { buildReport: vi.fn().mockResolvedValue(report) };
  const workspaces = {
    getWorkspace: vi.fn().mockResolvedValue(
      opts.workspaceExists === false
        ? null
        : { id: "ws1", name: "demo", targetLabel: "com.acme.app" },
    ),
  };
  vi.doMock("../src/modules/workspace/workspace.service.js", () => workspaces);
  vi.doMock("../src/report/builder.js", () => builder);

  const { reportRoutes } = await import("../src/api/v1/report.routes.js");
  const app = Fastify();
  await app.register(reportRoutes);
  return { app, builder };
}

describe("GET /workspaces/:id/report", () => {
  it("returns JSON by default, and verifies unless told not to", async () => {
    const { app, builder } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/workspaces/ws1/report" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json()).toEqual(report);
    expect(builder.buildReport).toHaveBeenCalledWith(expect.objectContaining({ id: "ws1" }), {
      status: undefined,
      verify: true,
    });
  });

  it("returns Markdown with a markdown content type", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/workspaces/ws1/report?format=markdown" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("# Findings report: com.acme.app");
  });

  it("returns SARIF 2.1.0 with the SARIF content type", async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: "GET", url: "/workspaces/ws1/report?format=sarif" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("application/sarif+json");
    expect(JSON.parse(res.body)).toMatchObject({ version: "2.1.0" });
  });

  it("passes the status filter and verify=false through", async () => {
    const { app, builder } = await buildApp();
    await app.inject({
      method: "GET",
      url: "/workspaces/ws1/report?status=confirmed&verify=false",
    });

    expect(builder.buildReport).toHaveBeenCalledWith(expect.anything(), {
      status: "confirmed",
      verify: false,
    });
  });

  it("rejects an unknown format, status or verify value, and an unknown workspace", async () => {
    const { app, builder } = await buildApp();
    for (const query of ["format=pdf", "status=maybe", "verify=yes"]) {
      const res = await app.inject({ method: "GET", url: `/workspaces/ws1/report?${query}` });
      expect(res.statusCode, query).toBe(400);
    }
    expect(builder.buildReport).not.toHaveBeenCalled();

    const missing = await buildApp({ workspaceExists: false });
    const res404 = await missing.app.inject({ method: "GET", url: "/workspaces/nope/report" });
    expect(res404.statusCode).toBe(404);
  });
});
