import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FastifyInstance } from "fastify";
import { config } from "../core/config.js";
import { eventBus } from "../events/event-bus.js";
import { orchestrator } from "../modules/mcp/orchestrator.js";
import type { HexForgePlugin, PluginContext } from "./types.js";

const INSTALLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "installed");

export interface LoadedPluginInfo {
  name: string;
  version?: string;
  description?: string;
}

const loadedPlugins: LoadedPluginInfo[] = [];

/** Snapshot of every plugin that loaded successfully this run, for the GET /plugins route. */
export function getLoadedPlugins(): LoadedPluginInfo[] {
  return loadedPlugins.slice();
}

function buildContext(app: FastifyInstance, pluginName: string): PluginContext {
  const prefix = `[plugin:${pluginName}]`;
  return {
    app,
    registerAgent: (kind, handler) => orchestrator.registerAgent(kind, handler),
    on: (event, listener) => eventBus.on(event, listener),
    log: {
      info: (msg) => console.log(`${prefix} ${msg}`),
      warn: (msg) => console.warn(`${prefix} ${msg}`),
      error: (msg) => console.error(`${prefix} ${msg}`),
    },
  };
}

/**
 * Discovers every plugin under plugins/installed/<name>/index.ts (each a
 * default-exported HexForgePlugin) and registers it against the running
 * Gateway. One plugin throwing during load never takes down the Gateway
 * or another plugin - it's logged and skipped, same "must never crash the
 * process" precedent as the Knowledge Indexer's event-driven work.
 *
 * Which plugins load can be restricted via PLUGINS_ENABLED (comma-
 * separated plugin names) in .env; unset means "load everything found".
 * Called once at startup from core/server.ts, after routes/indexers are
 * registered, so a plugin's own routes/listeners land on a fully-formed
 * Gateway.
 */
export async function loadPlugins(app: FastifyInstance): Promise<void> {
  let entries: string[];
  try {
    entries = (await readdir(INSTALLED_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return; // no installed/ directory yet - nothing to load
  }

  const allowList = config.PLUGINS_ENABLED
    ? new Set(
        config.PLUGINS_ENABLED.split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : null;

  for (const dirName of entries) {
    if (allowList && !allowList.has(dirName)) continue;

    // Same ".js"-specifier-for-a-.ts-file convention every static import
    // in this codebase already uses (tsx/tsc both resolve it correctly);
    // this just does it dynamically since the plugin list isn't known
    // ahead of time.
    const entryUrl = pathToFileURL(path.join(INSTALLED_DIR, dirName, "index.js")).href;

    try {
      const mod = (await import(entryUrl)) as { default?: HexForgePlugin };
      const plugin = mod.default;
      if (!plugin || typeof plugin.register !== "function") {
        throw new Error(`plugins/installed/${dirName}/index.ts must default-export a HexForgePlugin`);
      }

      await plugin.register(buildContext(app, plugin.name));
      loadedPlugins.push({ name: plugin.name, version: plugin.version, description: plugin.description });
      console.log(`[plugins] loaded "${plugin.name}"${plugin.version ? ` v${plugin.version}` : ""}`);
      eventBus.emit("plugin.loaded", { name: plugin.name });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[plugins] failed to load "${dirName}": ${message}`);
      eventBus.emit("plugin.failed", { name: dirName, error: message });
    }
  }
}
