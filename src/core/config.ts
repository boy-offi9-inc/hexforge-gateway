import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Off by default - this Gateway has always trusted whoever can reach it
  // (adb shell, filesystem write/delete, rebuilding APKs), which is fine
  // for a local single-user tool but not once it's reachable beyond
  // localhost. Set AUTH_ENABLED=true and API_KEYS once that's the case -
  // see core/auth.ts.
  AUTH_ENABLED: z.coerce.boolean().default(false),
  // Comma-separated list of accepted keys, so more than one person/device
  // can have their own (and you can revoke one without rotating all of them).
  API_KEYS: z.string().optional(),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // "local" (default): workspaces/knowledge never touch Supabase, even if
  // SUPABASE_URL is set - useful while iterating solo, or on a device
  // where Supabase reachability is flaky (mobile/Termux). "supabase":
  // restores the old behavior (Supabase primary, local storage as a
  // runtime-failure fallback) - switch to this once there's a real reason
  // to share state across devices/users, e.g. once a web interface exists.
  STORAGE_BACKEND: z.enum(["local", "supabase"]).default("local"),

  AI_PROVIDER: z
    .enum(["anthropic", "groq", "gemini", "ollama", "openai", "deepseek", "xai", "mistral", "openai-compatible"])
    .default("anthropic"),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-5"),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("llama-3.3-70b-versatile"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  // Ollama covers both local and cloud models through the same /api/chat
  // endpoint - which one you get depends only on OLLAMA_MODEL (cloud
  // models are named like "gpt-oss:120b-cloud") and whether
  // OLLAMA_API_KEY is set (required for cloud, irrelevant for local).
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OLLAMA_MODEL: z.string().default("llama3.3"),
  OLLAMA_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default("gpt-5.4-mini"),
  DEEPSEEK_API_KEY: z.string().optional(),
  // deepseek-chat/deepseek-reasoner (the names most docs still show) were
  // deprecated 2026-07-24 - deepseek-v4-flash/deepseek-v4-pro are current.
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),
  XAI_API_KEY: z.string().optional(),
  XAI_MODEL: z.string().default("grok-4-6"),
  MISTRAL_API_KEY: z.string().optional(),
  // "-latest" is a Mistral-maintained alias that follows their current
  // recommended model, rather than a specific version that goes stale.
  MISTRAL_MODEL: z.string().default("mistral-large-latest"),
  // Generic escape hatch for anything else speaking the OpenAI Chat
  // Completions shape: LM Studio (default port shown below), llama.cpp's
  // server, vLLM, text-generation-webui, OpenRouter, etc. No default
  // model - it varies entirely by what you're running, so it's required
  // when AI_PROVIDER=openai-compatible.
  OPENAI_COMPATIBLE_BASE_URL: z.string().default("http://localhost:1234/v1"),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().optional(),

  MCP_RUNTIME_MODE: z.enum(["local", "remote"]).default("local"),

  // Comma-separated plugin names (matching plugins/installed/<name>/) to
  // load. Unset = load every plugin found under plugins/installed/.
  PLUGINS_ENABLED: z.string().optional(),

  // Local directory where per-workspace agent output (decompiled sources,
  // logs, etc.) gets written. Created automatically if missing.
  WORKSPACES_ROOT: z.string().default("./workspaces"),

  // Local file-backed persistence - used as the storage backend when
  // Supabase isn't configured at all, and as a fallback when Supabase
  // *is* configured but a call fails at runtime (offline, DNS failure,
  // etc). See providers/local-storage.provider.ts.
  DATA_DIR: z.string().default("./data"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const apiKeys = new Set(
  (config.API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
);

// AUTH_ENABLED=true with no actual keys configured would lock everyone
// out including you, since there'd be nothing a request could match -
// treat that as still-open (with a startup warning, see index.ts) rather
// than silently bricking every route.
export const isAuthEffectivelyEnabled = config.AUTH_ENABLED && apiKeys.size > 0;

export const isSupabaseConfigured =
  !!config.SUPABASE_URL && !!config.SUPABASE_SERVICE_ROLE_KEY;

export const isAiConfigured = (() => {
  switch (config.AI_PROVIDER) {
    case "anthropic":
      return !!config.ANTHROPIC_API_KEY;
    case "groq":
      return !!config.GROQ_API_KEY;
    case "gemini":
      return !!config.GEMINI_API_KEY;
    case "ollama":
      // No key required for local models; OLLAMA_API_KEY is only needed
      // for cloud models, which is the user's call via OLLAMA_MODEL. We
      // can't verify the local server is actually reachable without a
      // network call, so "configured" just means "selected".
      return true;
    case "openai":
      return !!config.OPENAI_API_KEY;
    case "deepseek":
      return !!config.DEEPSEEK_API_KEY;
    case "xai":
      return !!config.XAI_API_KEY;
    case "mistral":
      return !!config.MISTRAL_API_KEY;
    case "openai-compatible":
      // No key required (most local servers don't check one) but a model
      // name is, since there's no sensible default across different servers.
      return !!config.OPENAI_COMPATIBLE_MODEL;
    default:
      return false;
  }
})();
