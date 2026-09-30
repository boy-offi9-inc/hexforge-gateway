import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

// registerAuth() reads `apiKeys` / `isAuthEffectivelyEnabled` from
// core/config.ts at import time, so each scenario mocks config.js with
// exactly the values it wants and re-imports auth.js fresh. The hook is
// registered *before* the routes, same order as buildServer() in
// core/server.ts - Fastify only applies an onRequest hook to routes
// defined after it, so the order here is part of what's being tested.
async function buildApp(cfg: { enabled: boolean; keys?: string[] }) {
  vi.resetModules();
  vi.doMock("../src/core/config.js", () => ({
    apiKeys: new Set(cfg.keys ?? []),
    isAuthEffectivelyEnabled: cfg.enabled,
  }));

  const { default: Fastify } = await import("fastify");
  const { registerAuth } = await import("../src/core/auth.js");

  const app = Fastify();
  await registerAuth(app);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/workspaces", async () => []);
  app.post("/workspaces", async () => ({ created: true }));
  await app.ready();
  return app;
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("registerAuth", () => {
  it("does nothing when auth isn't enabled - every route stays open", async () => {
    app = await buildApp({ enabled: false });

    const res = await app.inject({ method: "GET", url: "/workspaces" });

    expect(res.statusCode).toBe(200);
  });

  it("rejects a request with no key when auth is enabled", async () => {
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({ method: "GET", url: "/workspaces" });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain("API key");
  });

  it("rejects a wrong key", async () => {
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { authorization: "Bearer wrong" } });

    expect(res.statusCode).toBe(401);
  });

  it("accepts a valid key via Authorization: Bearer", async () => {
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { authorization: "Bearer secret" } });

    expect(res.statusCode).toBe(200);
  });

  it("accepts a valid key via X-API-Key", async () => {
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { "x-api-key": "secret" } });

    expect(res.statusCode).toBe(200);
  });

  it("accepts any one of several configured keys", async () => {
    app = await buildApp({ enabled: true, keys: ["first", "second"] });

    const res = await app.inject({ method: "GET", url: "/workspaces", headers: { "x-api-key": "second" } });

    expect(res.statusCode).toBe(200);
  });

  it("prefers the Bearer key over X-API-Key - a wrong Bearer isn't rescued by a valid X-API-Key", async () => {
    // Same precedence as mcp-server/http.ts, so the two servers behave
    // identically from a client's perspective if it sends both headers.
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({
      method: "GET",
      url: "/workspaces",
      headers: { authorization: "Bearer wrong", "x-api-key": "secret" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("exempts GET /health so uptime checks don't need a key", async () => {
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
  });

  it("only exempts GET /health - other methods and routes still require a key", async () => {
    app = await buildApp({ enabled: true, keys: ["secret"] });

    const res = await app.inject({ method: "POST", url: "/workspaces", payload: {} });

    expect(res.statusCode).toBe(401);
  });
});
