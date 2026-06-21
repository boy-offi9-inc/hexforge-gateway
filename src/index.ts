import { buildServer } from "./core/server.js";
import { config, isAuthEffectivelyEnabled } from "./core/config.js";
import * as workspaceService from "./modules/workspace/workspace.service.js";

async function printStartupBanner(baseUrl: string) {
  // Best-effort - a Supabase hiccup here should never stop the Gateway
  // from starting, it just means the banner is a bit less helpful.
  let workspaces: Awaited<ReturnType<typeof workspaceService.listWorkspaces>> = [];
  try {
    workspaces = await workspaceService.listWorkspaces();
  } catch {
    // ignore - banner just shows the generic quickstart below
  }

  console.log("");
  console.log(`HexForge Gateway listening on ${baseUrl}`);
  console.log(`  storage: ${config.STORAGE_BACKEND}${config.STORAGE_BACKEND === "local" ? ` (${config.DATA_DIR})` : ""}`);
  console.log(`  ai: ${config.AI_PROVIDER}`);
  console.log(`  auth: ${isAuthEffectivelyEnabled ? "enabled" : "OPEN - anyone who can reach this port has full access"}`);
  console.log("");

  if (workspaces.length > 0) {
    console.log(`Existing workspaces (${workspaces.length}):`);
    for (const w of workspaces.slice(0, 10)) {
      console.log(`  ${w.id}  ${w.name}  [${w.status}]`);
    }
    console.log("");
  } else {
    console.log("No workspaces yet.");
    console.log("");
  }

  console.log("Get started:");
  console.log(`  curl -X PUT ${baseUrl}/workspaces/by-name/my-project -d '{"targetLabel":"com.example.app"}' -H "Content-Type: application/json"`);
  console.log("  ./scripts/hf.sh ws my-project");
  console.log(`  curl ${baseUrl}/          # full cheat sheet with live data`);
  console.log("  See README.md for the full API.");
  console.log("");
}

async function main() {
  const app = await buildServer();

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    const baseUrl = `http://${config.HOST}:${config.PORT}`;
    app.log.info(`HexForge Gateway listening on ${baseUrl}`);
    await printStartupBanner(baseUrl);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
