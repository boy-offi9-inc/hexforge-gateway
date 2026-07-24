import type { FastifyInstance } from "fastify";
import { getLoadedPlugins } from "../../plugins/loader.js";

export async function pluginIntrospectionRoutes(app: FastifyInstance) {
  app.get("/plugins", async () => {
    return getLoadedPlugins();
  });
}
