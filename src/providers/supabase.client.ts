import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config, isSupabaseConfigured } from "../core/config.js";

let client: SupabaseClient | null = null;

// STORAGE_BACKEND="local" (the default) means workspaces/knowledge never
// touch Supabase even if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are set -
// gating it here means workspace.service.ts / knowledge.service.ts don't
// need to know about STORAGE_BACKEND at all; they already fall back to
// local storage whenever this returns null.
if (config.STORAGE_BACKEND === "supabase" && isSupabaseConfigured) {
  client = createClient(config.SUPABASE_URL!, config.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  });
}

/**
 * Returns the Supabase client, or null if not configured or if
 * STORAGE_BACKEND="local". Gateway falls back to local file storage (see
 * providers/local-storage.provider.ts) whenever this returns null.
 */
export function getSupabase(): SupabaseClient | null {
  return client;
}
