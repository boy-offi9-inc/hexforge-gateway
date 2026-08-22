import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";

const execFileAsync = promisify(execFile);

const ALLOWED_EXTENSIONS = [".apk", ".dex", ".jar", ".aar", ".zip"];

interface JadxPayload {
  apkPath: string;
}

function assertValidPayload(payload: Record<string, unknown>): JadxPayload {
  const apkPath = payload.apkPath;
  if (typeof apkPath !== "string" || apkPath.trim().length === 0) {
    throw new Error('jadx agent requires a "apkPath" string in the task payload');
  }

  const resolved = path.resolve(apkPath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found at path: ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type "${ext}". Expected one of: ${ALLOWED_EXTENSIONS.join(", ")}`);
  }

  return { apkPath: resolved };
}

/**
 * Recursively lists files under a directory, capped to avoid flooding
 * the response for very large decompiled trees. Full traversal should
 * happen via a dedicated "browse workspace files" endpoint later.
 */
async function listFilesCapped(dir: string, limit = 200): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string) {
    if (results.length >= limit) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        results.push(path.relative(dir, full));
      }
    }
  }

  await walk(dir);
  return results;
}

export async function jadxHandler(task: McpTask): Promise<unknown> {
  if (task.operation !== "decompile") {
    throw new Error(`Unsupported jadx operation "${task.operation}". Supported: "decompile"`);
  }

  const { apkPath } = assertValidPayload(task.payload);

  const outputDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "jadx");
  await mkdir(outputDir, { recursive: true });

  try {
    // -d: output directory, -r: skip resources decode for speed (optional
    // - remove if you want resources too). --show-bad-code keeps going
    // past errors instead of aborting the whole decompile.
    const { stdout, stderr } = await execFileAsync(
      "jadx",
      ["-d", outputDir, "--show-bad-code", apkPath],
      { maxBuffer: 1024 * 1024 * 20 } // 20MB buffer for verbose jadx output
    );

    const files = await listFilesCapped(outputDir);

    return {
      outputDir,
      fileCount: files.length,
      files,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr ? stderr.slice(-2000) : undefined,
    };
  } catch (err) {
    throw friendlyExecError(
      "jadx",
      'Install it first (e.g. "brew install jadx" or see https://github.com/skylot/jadx/releases).',
      err
    );
  }
}
