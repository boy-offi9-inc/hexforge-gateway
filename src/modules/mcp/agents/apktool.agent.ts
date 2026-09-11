import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";

const execFileAsync = promisify(execFile);

const ALLOWED_EXTENSIONS = [".apk", ".jar", ".zip"];

interface DecodePayload {
  apkPath: string;
  noSrc?: boolean; // skip smali disassembly (resources only, faster)
  noRes?: boolean; // skip resource decoding (smali only)
  force?: boolean; // overwrite existing output dir
}

interface BuildPayload {
  inputDir: string; // decoded project directory (output of a prior "decode")
  outputName?: string; // file name written under WORKSPACES_ROOT/<workspaceId>/apktool/build/
}

function resolveExistingApk(apkPath: string): string {
  const resolved = path.resolve(apkPath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found at path: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type "${ext}". Expected one of: ${ALLOWED_EXTENSIONS.join(", ")}`);
  }
  return resolved;
}

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

async function decodeHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as DecodePayload;
  if (!payload.apkPath) {
    throw new Error('decode requires "apkPath" in the task payload');
  }
  const apkPath = resolveExistingApk(payload.apkPath);

  const outputDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "apktool", "decode");
  await mkdir(path.dirname(outputDir), { recursive: true });

  const args = ["d", apkPath, "-o", outputDir, "-f"]; // -f: always overwrite, workspace-scoped dir is ours to manage
  if (payload.noSrc) args.push("-s");
  if (payload.noRes) args.push("-r");

  try {
    const { stdout, stderr } = await execFileAsync("apktool", args, {
      maxBuffer: 1024 * 1024 * 20,
    });

    const files = await listFilesCapped(outputDir);

    return {
      outputDir,
      fileCount: files.length,
      files,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr ? stderr.slice(-2000) : undefined,
    };
  } catch (err) {
    throw friendlyExecError("apktool", "Install it first (e.g. via your package manager, or see https://apktool.org/docs/install).", err);
  }
}

async function buildHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as BuildPayload;
  if (!payload.inputDir) {
    throw new Error('build requires "inputDir" (a decoded apktool project directory) in the task payload');
  }

  const inputDir = path.resolve(payload.inputDir);
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
    throw new Error(`Directory not found at path: ${inputDir}`);
  }
  // apktool.yml is the marker file every decoded project has; catches
  // pointing this at a random folder before wasting time on a doomed build.
  if (!existsSync(path.join(inputDir, "apktool.yml"))) {
    throw new Error(
      `"${inputDir}" doesn't look like an apktool project (no apktool.yml found). Did you mean the output of a prior "decode" operation?`
    );
  }

  const buildDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "apktool", "build");
  await mkdir(buildDir, { recursive: true });

  const outputName = payload.outputName?.trim() || "rebuilt.apk";
  if (outputName.includes("/") || outputName.includes("\\") || outputName.includes("..")) {
    throw new Error('"outputName" must be a plain file name, not a path');
  }
  const outputPath = path.join(buildDir, outputName);

  try {
    const { stdout, stderr } = await execFileAsync("apktool", ["b", inputDir, "-o", outputPath], {
      maxBuffer: 1024 * 1024 * 20,
    });

    return {
      outputPath,
      // Rebuilt APKs from apktool are NOT signed - a real device/emulator
      // install needs signing first (e.g. via apksigner or the apkmcp
      // agent's build tooling, which handles signing as part of its flow).
      signed: false,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr ? stderr.slice(-2000) : undefined,
    };
  } catch (err) {
    throw friendlyExecError("apktool", "Install it first (e.g. via your package manager, or see https://apktool.org/docs/install).", err);
  }
}

export async function apktoolHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "decode":
      return decodeHandler(task);
    case "build":
      return buildHandler(task);
    default:
      throw new Error(`Unsupported apktool operation "${task.operation}". Supported: "decode", "build"`);
  }
}
