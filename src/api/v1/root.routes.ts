import type { FastifyInstance } from "fastify";
import * as workspaceService from "../../modules/workspace/workspace.service.js";

/**
 * GET / is the front door for anyone hitting the API without the README
 * open - contributors especially. Rather than a bare 404 or a static
 * "hello world", it shows real, current state: what workspaces already
 * exist (so someone doesn't have to guess or dig through Supabase) and
 * copy-pasteable commands to get going, including the get-or-create
 * PUT /workspaces/by-name route so a first-timer never has to manually
 * generate or track an id.
 */
export async function rootRoutes(app: FastifyInstance) {
  app.get("/", async (req) => {
    const workspaces = await workspaceService.listWorkspaces();
    const base = `${req.protocol}://${req.hostname}`;

    return {
      name: "HexForge Gateway",
      description: "AI-assisted APK reverse-engineering workspace API.",
      docs: "See README.md in the repo for the full API reference.",
      workspaces: {
        count: workspaces.length,
        recent: workspaces.slice(0, 10).map((w) => ({ id: w.id, name: w.name, status: w.status })),
      },
      quickstart: [
        `curl -X PUT ${base}/workspaces/by-name/my-project -H "Content-Type: application/json" -d '{"targetLabel": "com.example.app"}'`,
        `curl ${base}/workspaces`,
        `curl -X POST ${base}/workspaces/<id>/jobs -H "Content-Type: application/json" -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "/path/app.apk"}}'`,
        "Or use the CLI wrapper: ./scripts/hf.sh ws my-project && ./scripts/hf.sh job jadx decompile '{...}'",
      ],
    };
  });
}
