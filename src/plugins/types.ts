import type { FastifyInstance } from "fastify";
import type { AgentHandler } from "../modules/mcp/orchestrator.js";
import type { EventMap } from "../events/types.js";

/**
 * The full API surface a plugin gets, per HexForge_Architecture_v2.md's
 * Plugin System ("Allows official and community extensions without
 * changing the core"). A plugin never imports the orchestrator, the Event
 * Bus, or the Fastify app directly - it only gets what this context hands
 * it, so the core is free to change its internals as long as this shape
 * stays stable. This is the same reason modules talk through the Event
 * Bus instead of holding direct references to each other.
 */
export interface PluginContext {
  /** Register routes on the Gateway's Fastify instance, e.g. `ctx.app.get(...)`. */
  app: FastifyInstance;
  /** Register a new MCP agent kind - usable in Tasks/Jobs/Workflows exactly like the built-in agents (jadx, apktool, ai, ...). */
  registerAgent(kind: string, handler: AgentHandler): void;
  /** Subscribe to any Event Bus event without importing the Event Bus module. */
  on<K extends keyof EventMap>(event: K, listener: (payload: EventMap[K]) => void): void;
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export interface HexForgePlugin {
  /** Unique, stable identifier - shown in logs and used by PLUGINS_ENABLED filtering. Should match the plugin's directory name under plugins/installed/. */
  name: string;
  version?: string;
  description?: string;
  register(ctx: PluginContext): void | Promise<void>;
}
