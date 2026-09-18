import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import type { HexForgePlugin } from "../../types.js";

// Reference plugin - shows what "extending the core without changing it"
// looks like end to end: a new MCP agent (usable in Tasks/Jobs/Workflows
// exactly like jadx/apktool), an Event Bus subscription, and a plugin-
// owned route, none of which required touching anything under src/modules
// or src/api. Copy this folder as a starting point for a real plugin.

const execFileAsync = promisify(execFile);
const MAX_STRINGS = 500;
const DEFAULT_MIN_LENGTH = 4;

interface ExtractPayload {
  filePath: string;
  minLength?: number;
}

async function extractHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as ExtractPayload;
  if (!payload.filePath) {
    throw new Error('extract requires "filePath" in the task payload');
  }

  const filePath = path.resolve(payload.filePath);
  if (!existsSync(filePath)) {
    throw new Error(`File not found at path: ${filePath}`);
  }

  const minLength = payload.minLength && payload.minLength > 0 ? payload.minLength : DEFAULT_MIN_LENGTH;

  try {
    const { stdout } = await execFileAsync("strings", ["-n", String(minLength), filePath], {
      maxBuffer: 1024 * 1024 * 20,
    });
    const lines = stdout.split("\n").filter(Boolean);

    return {
      filePath,
      count: lines.length,
      strings: lines.slice(0, MAX_STRINGS),
      truncated: lines.length > MAX_STRINGS,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error('"strings" executable not found on PATH (part of binutils on most Linux/macOS installs).');
    }
    throw new Error(`strings failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function stringsAgent(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "extract":
      return extractHandler(task);
    default:
      throw new Error(`Unsupported strings operation "${task.operation}". Supported: "extract"`);
  }
}

const plugin: HexForgePlugin = {
  name: "example-strings",
  version: "0.1.0",
  description: 'Reference plugin - runs the "strings" utility on any file via a new "strings" MCP agent.',

  register(ctx) {
    // 1. New MCP agent kind - dispatchable via /workspaces/:id/tasks,
    //    /workspaces/:id/jobs, or as a Workflow step, same as any built-in.
    ctx.registerAgent("strings", stringsAgent);

    // 2. Event Bus subscription - reacts to Gateway activity without
    //    importing the Event Bus or Job Engine.
    ctx.on("job.completed", (payload) => {
      if (payload.job.agent !== "strings") return;
      const result = payload.job.result as { filePath?: string; count?: number } | undefined;
      ctx.log.info(`job ${payload.job.id} extracted ${result?.count ?? "?"} strings from ${result?.filePath}`);
    });

    // 3. Plugin-owned route.
    ctx.app.get("/plugins/example-strings/info", async () => ({
      name: plugin.name,
      version: plugin.version,
      agent: "strings",
      operations: ["extract"],
    }));
  },
};

export default plugin;
