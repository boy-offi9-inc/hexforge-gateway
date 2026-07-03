import type { FastifyInstance } from "fastify";
import { config, isSupabaseConfigured, isAiConfigured, isAuthEffectivelyEnabled } from "../../core/config.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
      time: new Date().toISOString(),
      storageBackend: config.STORAGE_BACKEND,
      supabaseConfigured: isSupabaseConfigured,
      aiProvider: config.AI_PROVIDER,
      aiConfigured: isAiConfigured,
      authEnabled: isAuthEffectivelyEnabled,
    };
  });
}
