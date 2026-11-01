import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";
import { applyTextPatch, MAX_PATCH_FILE_BYTES } from "./apk-patch.js";
import { withSavedOutput } from "./task-output.js";

const execFileAsync = promisify(execFile);

const ALLOWED_EXTENSIONS = [".apk", ".jar", ".zip"];

interface DecodePayload {
  apkPath: string;
  noSrc?: boolean; // skip smali disassembly (resources only, faster)
  noRes?: boolean; // skip resource decoding (smali only)
  force?: boolean; // overwrite existing output dir
}

interface BuildPayload {
  // The decoded project directory. A workflow can leave this out: with
  // mergePreviousResult, a preceding "decode" supplies `outputDir` and a
  // preceding "patch" supplies `projectDir`.
  inputDir?: string;
  projectDir?: string;
  outputDir?: string;
  outputName?: string; // file name written under WORKSPACES_ROOT/<workspaceId>/apktool/build/
}

interface PatchPayload {
  projectDir?: string; // decoded project directory (`inputDir` / `outputDir` also accepted)
  inputDir?: string;
  outputDir?: string;
  file?: string; // path inside the project, e.g. "smali/com/acme/Login.smali"
  find?: string; // exact text to replace
  replace?: string;
  all?: boolean; // replace every match instead of requiring exactly one
}

function resolveExistingApk(apkPath: string): string {
  const resolved = path.resolve(apkPath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found at path: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file type "${ext}". Expected one of: ${ALLOWED_EXTENSIONS.join(", ")}`,
    );
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
    throw friendlyExecError(
      "apktool",
      "Install it first (e.g. via your package manager, or see https://apktool.org/docs/install).",
      err,
    );
  }
}

async function buildHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as BuildPayload;
  const projectDir = payload.inputDir ?? payload.projectDir ?? payload.outputDir;
  if (!projectDir) {
    throw new Error(
      'build requires "inputDir" (a decoded apktool project directory) in the task payload',
    );
  }

  const inputDir = path.resolve(projectDir);
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
    throw new Error(`Directory not found at path: ${inputDir}`);
  }
  // apktool.yml is the marker file every decoded project has; catches
  // pointing this at a random folder before wasting time on a doomed build.
  if (!existsSync(path.join(inputDir, "apktool.yml"))) {
    throw new Error(
      `"${inputDir}" doesn't look like an apktool project (no apktool.yml found). Did you mean the output of a prior "decode" operation?`,
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
      // install needs signing first: the apksigner agent's "sign" operation
      // takes this outputPath as its input.
      signed: false,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr ? stderr.slice(-2000) : undefined,
    };
  } catch (err) {
    throw friendlyExecError(
      "apktool",
      "Install it first (e.g. via your package manager, or see https://apktool.org/docs/install).",
      err,
    );
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Edits one text file inside a decoded project by replacing exact text, and
 * saves a record of what changed so the modification is tracked rather than
 * silent. The file has to stay inside the project (symlinks included), be
 * plain text, and be under MAX_PATCH_FILE_BYTES.
 *
 * The returned keys are chosen not to collide with this operation's own input
 * keys (file, find, replace, all): in a workflow with mergePreviousResult the
 * result is merged into the next step's payload and wins, so a `file` in the
 * result would overwrite the next patch's `file`. `projectDir` is returned so
 * the next patch, or the build, finds the project without being told.
 */
async function patchHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as PatchPayload;
  const projectDir = payload.projectDir ?? payload.inputDir ?? payload.outputDir;
  if (!projectDir) {
    throw new Error('patch requires "projectDir" (a decoded apktool project directory)');
  }
  if (!payload.file) throw new Error('patch requires "file" (a path inside the project)');
  if (typeof payload.find !== "string" || typeof payload.replace !== "string") {
    throw new Error(
      'patch requires "find" and "replace" (the exact text to look for, and its replacement)',
    );
  }

  const dir = path.resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Directory not found at path: ${dir}`);
  }
  if (!existsSync(path.join(dir, "apktool.yml"))) {
    throw new Error(
      `"${dir}" doesn't look like an apktool project (no apktool.yml found). Did you mean the output of a prior "decode" operation?`,
    );
  }

  const relative = payload.file.split("\\").join("/");
  if (relative.includes("\0") || path.isAbsolute(relative)) {
    throw new Error('"file" must be a relative path inside the project');
  }
  let target: string;
  try {
    target = await realpath(path.resolve(dir, relative));
  } catch {
    throw new Error(`No such file in the project: ${relative}`);
  }
  const root = await realpath(dir);
  const within = path.relative(root, target);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('"file" points outside the project');
  }

  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Not a file: ${relative}`);
  if (info.size > MAX_PATCH_FILE_BYTES) {
    throw new Error(
      `${relative} is larger than ${MAX_PATCH_FILE_BYTES} bytes; patch is for text files`,
    );
  }
  const original = await readFile(target);
  if (original.includes(0)) {
    throw new Error(`${relative} looks like a binary file; patch only edits text files`);
  }

  const before = original.toString("utf8");
  const outcome = applyTextPatch(before, payload.find, payload.replace, payload.all === true);
  await writeFile(target, outcome.text, "utf8");

  const record = {
    patchedFile: relative,
    replacements: outcome.replacements,
    changes: outcome.changes,
    sha256Before: sha256(original),
    sha256After: sha256(outcome.text),
  };
  // The saved record is the part that gets recorded as an artifact, so it holds no
  // machine paths; the project directory is added to what's returned afterwards.
  const saved = await withSavedOutput(task, "apktool/patches", record);
  return { ...saved, projectDir: dir };
}

export async function apktoolHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "decode":
      return decodeHandler(task);
    case "build":
      return buildHandler(task);
    case "patch":
      return patchHandler(task);
    default:
      throw new Error(
        `Unsupported apktool operation "${task.operation}". Supported: "decode", "patch", "build"`,
      );
  }
}
