import type { FastifyInstance } from "fastify";
import {
  config,
  isSupabaseConfigured,
  isAiConfigured,
  isAuthEffectivelyEnabled,
} from "../../core/config.js";
import { isStorageDegraded } from "../../providers/storage.provider.js";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return {
      status: "ok",
      time: new Date().toISOString(),
      storageBackend: config.STORAGE_BACKEND,
      // degraded = the remote backend (supabase/postgres) failed at least
      // once and the local provider is answering writes instead - those
      // writes are NOT replayed to the remote backend on recovery
      // (docs/SETUP.md), so this flag is how an operator finds out before
      // assuming the database is the source of truth.
      degraded: isStorageDegraded(),
      supabaseConfigured: isSupabaseConfigured,
      aiProvider: config.AI_PROVIDER,
      aiConfigured: isAiConfigured,
      authEnabled: isAuthEffectivelyEnabled,
      hostExposure: ["127.0.0.1", "localhost", "::1"].includes(config.HOST)
        ? "localhost-only"
        : "remote",
    };
  });
}
