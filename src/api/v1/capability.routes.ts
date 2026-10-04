import type { FastifyInstance } from "fastify";
import { capabilityRegistry } from "../../capabilities/registry.js";

/** Read-only introspection: what the Gateway can do, and which adapters provide it. */
export async function capabilityRoutes(app: FastifyInstance) {
  app.get("/capabilities", async () => ({
    capabilities: capabilityRegistry.listCapabilities().map((id) => ({
      id,
      providers: capabilityRegistry.providersOf(id).map((p) => ({
        agent: p.adapter.kind,
        operations: p.operations.map((op) => op.name),
        priority: p.adapter.priority ?? 0,
      })),
    })),
    // The availability probe is a function, so it is left out of the JSON.
    adapters: capabilityRegistry
      .listAdapters()
      .map(({ isAvailable: _probe, ...adapter }) => adapter),
  }));
}
