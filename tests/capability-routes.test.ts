import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { capabilityRoutes } from "../src/api/v1/capability.routes.js";
import { capabilityRegistry } from "../src/capabilities/registry.js";

// A bare Fastify instance with just this route plugin, driven through
// app.inject() (same approach as api-routes.test.ts). The route reads the
// module-level registry singleton, so each test registers its own adapter and
// afterEach removes it again.
const KINDS = ["jadxai", "jadx"];

afterEach(() => {
  for (const kind of KINDS) capabilityRegistry.unregister(kind);
});

describe("GET /capabilities", () => {
  it("lists providers by priority and omits the availability probe", async () => {
    capabilityRegistry.register({
      kind: "jadx",
      operations: [{ name: "decompile", capability: "java.decompile" }],
    });
    capabilityRegistry.register({
      kind: "jadxai",
      priority: 10,
      isAvailable: () => true,
      operations: [{ name: "decompile-gui", capability: "java.decompile" }],
    });

    const app = Fastify();
    await app.register(capabilityRoutes);
    const res = await app.inject({ method: "GET", url: "/capabilities" });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const cap = body.capabilities.find((c: { id: string }) => c.id === "java.decompile");
    expect(cap.providers).toEqual([
      { agent: "jadxai", operations: ["decompile-gui"], priority: 10 },
      { agent: "jadx", operations: ["decompile"], priority: 0 },
    ]);
    expect(body.adapters.map((a: { kind: string }) => a.kind)).toEqual(
      expect.arrayContaining(KINDS),
    );
    for (const adapter of body.adapters) expect(adapter).not.toHaveProperty("isAvailable");
  });
});
