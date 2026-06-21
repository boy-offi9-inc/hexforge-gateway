import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
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

  return app;
}
