import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { healthRoutes } from "../api/v1/health.routes.js";
import { rootRoutes } from "../api/v1/root.routes.js";
import { workspaceRoutes } from "../api/v1/workspace.routes.js";
import { jobRoutes } from "../api/v1/job.routes.js";
import { workflowRoutes } from "../api/v1/workflow.routes.js";
import { registerAuth } from "./auth.js";
import { config } from "./config.js";

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: config.NODE_ENV === "development" ? "info" : "warn",
    },
  });

  await app.register(websocketPlugin);
  await registerAuth(app);

  await app.register(healthRoutes);
  await app.register(rootRoutes);
  await app.register(workspaceRoutes);
  await app.register(jobRoutes);
  await app.register(workflowRoutes);

  return app;
}
