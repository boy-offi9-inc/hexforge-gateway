import { existsSync } from "node:fs";
import { buildServer } from "./core/server.js";
import { config, isAiConfigured, isAuthEffectivelyEnabled } from "./core/config.js";
import {
  createConsoleUi,
  detectConsoleCaps,
  listenAddresses,
  packageVersion,
  renderBanner,
} from "./core/console-ui.js";
import type { ConsoleCaps } from "./core/console-ui.js";
import { getLoadedPlugins } from "./plugins/loader.js";
import * as workspaceService from "./modules/workspace/workspace.service.js";
import { jobEngine } from "./modules/jobs/job-engine.js";
import { workflowEngine } from "./modules/workflow/workflow-engine.js";
import { inboxWatcher } from "./modules/inbox/inbox-watcher.js";

/**
 * The startup banner for an interactive terminal - see core/console-ui.ts.
 * Everything the plain banner below says, in one box, plus the other
 * addresses the server is reachable on and the warnings that matter
 * (auth off on a reachable port, AI provider unconfigured).
 */
async function printPrettyBanner(caps: ConsoleCaps) {
  let workspaces: { name: string }[] = [];
  try {
    workspaces = await workspaceService.listWorkspaces();
  } catch {
    // best-effort, same as the plain banner - the box just says "none yet"
  }
  const lines = renderBanner(
    {
      version: packageVersion(),
      addresses: listenAddresses(config.HOST, config.PORT),
      storage: `${config.STORAGE_BACKEND}${config.STORAGE_BACKEND === "local" ? ` (${config.DATA_DIR})` : ""}`,
      ai: { provider: config.AI_PROVIDER, configured: isAiConfigured },
      auth: {
        enabled: isAuthEffectivelyEnabled,
        requested: config.AUTH_ENABLED,
      },
      plugins: getLoadedPlugins(),
      inbox: inboxWatcher.watching,
      workspaces,
    },
    createConsoleUi(caps),
  );
  console.log(["", ...lines].join("\n"));
}

/** The original banner, unchanged: what systemd/Docker/a pipe (or LOG_FORMAT=json) gets. */
async function printPlainBanner(baseUrl: string) {
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
  console.log(
    `  storage: ${config.STORAGE_BACKEND}${config.STORAGE_BACKEND === "local" ? ` (${config.DATA_DIR})` : ""}`,
  );
  console.log(`  ai: ${config.AI_PROVIDER}`);
  console.log(
    `  auth: ${isAuthEffectivelyEnabled ? "enabled" : "OPEN - anyone who can reach this port has full access"}`,
  );
  if (config.AUTH_ENABLED && !isAuthEffectivelyEnabled) {
    console.log(
      `  WARNING: AUTH_ENABLED=true but no API_KEYS set - auth is NOT actually active. Set API_KEYS in .env.`,
    );
  }
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
  console.log(
    `  curl -X PUT ${baseUrl}/workspaces/by-name/my-project -d '{"targetLabel":"com.example.app"}' -H "Content-Type: application/json"`,
  );
  console.log("  ./scripts/hf.sh ws my-project");
  console.log(`  curl ${baseUrl}/          # full cheat sheet with live data`);
  console.log("  Full API and guides: README.md and docs/.");
  console.log("");
}

async function main() {
  const app = await buildServer();

  // Reload Job/Workflow history before accepting traffic. Anything left
  // "running"/"queued" from before this restart gets marked "failed" -
  // there's no in-flight McpTask to resume against.
  try {
    await jobEngine.hydrate();
    await workflowEngine.hydrate();
  } catch (err) {
    app.log.warn(
      { err },
      "Failed to hydrate Job/Workflow history from storage - starting with empty state",
    );
  }

  inboxWatcher.start();

  // Remote exposure without working auth is refused, not warned about: this
  // Gateway can run adb shell, write/delete files and rebuild APKs. The
  // HOST env is the explicit opt-in - it defaults to 127.0.0.1. A container
  // is the documented exception: its namespace is isolated and the real
  // exposure is the host-side port mapping (the published compose file
  // binds 127.0.0.1), which this process cannot see - so it warns instead.
  const inContainer = existsSync("/.dockerenv");
  const remoteHost = !["127.0.0.1", "localhost", "::1"].includes(config.HOST);
  if (remoteHost && !isAuthEffectivelyEnabled && !inContainer) {
    console.error(
      `Refusing to start: HOST=${config.HOST} exposes the Gateway beyond localhost, but auth is not configured. ` +
        "Set AUTH_ENABLED=true and API_KEYS, or remove HOST to bind 127.0.0.1 only (docs/SAFETY.md).",
    );
    process.exit(1);
  }
  if (remoteHost && !isAuthEffectivelyEnabled && inContainer) {
    console.warn(
      "WARNING: the container's Gateway listens on every interface with auth off. " +
        "This is safe only while the host-side port mapping stays on 127.0.0.1 (as the published docker-compose.yml does). " +
        "If you publish the port publicly, set AUTH_ENABLED=true and API_KEYS (docs/SAFETY.md).",
    );
  }

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    const baseUrl = `http://${config.HOST}:${config.PORT}`;
    const caps = detectConsoleCaps();
    if (caps.pretty) {
      await printPrettyBanner(caps);
    } else {
      app.log.info(`HexForge Gateway listening on ${baseUrl}`);
      await printPlainBanner(baseUrl);
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
