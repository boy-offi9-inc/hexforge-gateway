import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { healthRoutes } from "../api/v1/health.routes.js";
import { rootRoutes } from "../api/v1/root.routes.js";
import { workspaceRoutes } from "../api/v1/workspace.routes.js";
import { jobRoutes } from "../api/v1/job.routes.js";
import { workflowRoutes } from "../api/v1/workflow.routes.js";
import { knowledgeRoutes } from "../api/v1/knowledge.routes.js";
import { pluginIntrospectionRoutes } from "../api/v1/plugin.routes.js";
import { capabilityRoutes } from "../api/v1/capability.routes.js";
import { artifactRoutes } from "../api/v1/artifact.routes.js";
import { findingRoutes } from "../api/v1/finding.routes.js";
import { register as registerKnowledgeIndexer } from "../modules/knowledge/knowledge-indexer.js";
import { register as registerArtifactRecorder } from "../artifacts/recorder.js";
import { loadPlugins } from "../plugins/loader.js";
import { registerWebsocketGateway } from "./websocket.js";
import { registerAuth } from "./auth.js";
import { config } from "./config.js";
import { createConsoleUi, createPrettyLogStream, detectConsoleCaps } from "./console-ui.js";

export async function buildServer() {
  // On an interactive terminal, give pino a destination that renders its
  // JSON lines as readable one-liners (see core/console-ui.ts) - every
  // existing log call, plugins' included, goes through it unchanged. Under
  // systemd/Docker/a pipe, or LOG_FORMAT=json, `stream` is left out and
  // Fastify logs structured JSON to stdout exactly as before.
  const consoleCaps = detectConsoleCaps();
  const loggerOptions = {
    level: config.NODE_ENV === "development" ? "info" : "warn",
    ...(consoleCaps.pretty
      ? { stream: createPrettyLogStream(createConsoleUi(consoleCaps)).stream }
      : {}),
  };
  const app = Fastify({ logger: loggerOptions });

  await app.register(websocketPlugin);
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(rootRoutes);
  await app.register(workspaceRoutes);
  await app.register(jobRoutes);
  await app.register(workflowRoutes);
  await app.register(knowledgeRoutes);
  await app.register(pluginIntrospectionRoutes);
  await app.register(capabilityRoutes);
  await app.register(artifactRoutes);
  await app.register(findingRoutes);
  await registerWebsocketGateway(app);

  // Background listener, not a route - turns finished workflow runs into
  // Knowledge Engine entries via the Event Bus (see knowledge-indexer.ts).
  registerKnowledgeIndexer();

  // Records the directories/files finished tasks produced, using the agents'
  // capability descriptors (see artifacts/recorder.ts).
  registerArtifactRecorder();

  // Loaded last so plugin-registered routes/agents/listeners land on a
  // fully-formed Gateway (all core routes and indexers already active).
  await loadPlugins(app);

  return app;
}
