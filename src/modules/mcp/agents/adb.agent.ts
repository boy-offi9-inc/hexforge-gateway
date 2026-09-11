import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";

const execFileAsync = promisify(execFile);

// "shell" runs an arbitrary command on a device you already have adb
// access to - as powerful as using adb yourself from a terminal. Fine for
// the same reason apktool/jadx trust arbitrary local paths: this is a
// local, single-user dev tool. Don't expose the Gateway beyond localhost
// without adding auth in front of it first.

interface DeviceScopedPayload {
  deviceSerial?: string;
}

interface ShellPayload extends DeviceScopedPayload {
  command: string;
}

interface InstallPayload extends DeviceScopedPayload {
  apkPath: string;
  reinstall?: boolean; // adb install -r
}

interface UninstallPayload extends DeviceScopedPayload {
  packageName: string;
  keepData?: boolean; // adb uninstall -k
}

interface PackagesPayload extends DeviceScopedPayload {
  filter?: string; // substring match, passed to `pm list packages <filter>`
}

interface LogcatPayload extends DeviceScopedPayload {
  filter?: string; // e.g. "MyTag:D *:S" - passed straight to logcat's filterspec
  lines?: number; // tail this many lines from the dump, default 200
}

interface PullPayload extends DeviceScopedPayload {
  remotePath: string;
  fileName?: string; // defaults to the remote basename; written under WORKSPACES_ROOT/<workspaceId>/adb/pulled/
}

interface PushPayload extends DeviceScopedPayload {
  localPath: string;
  remotePath: string;
}

function deviceArgs(payload: DeviceScopedPayload): string[] {
  return payload.deviceSerial ? ["-s", payload.deviceSerial] : [];
}

async function run(args: string[], maxBuffer = 1024 * 1024 * 20) {
  try {
    return await execFileAsync("adb", args, { maxBuffer });
  } catch (err) {
    throw friendlyExecError("adb", "Install Android platform-tools first (e.g. \"brew install android-platform-tools\", or see https://developer.android.com/tools/releases/platform-tools).", err);
  }
}

async function devicesHandler(): Promise<unknown> {
  const { stdout } = await run(["devices", "-l"]);
  const lines = stdout.split("\n").slice(1).map((l) => l.trim()).filter(Boolean);
  const devices = lines.map((line) => {
    const [serial, state, ...rest] = line.split(/\s+/);
    return { serial, state, extra: rest.join(" ") };
  });
  return { devices };
}

async function packagesHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as PackagesPayload;
  const args = [...deviceArgs(payload), "shell", "pm", "list", "packages"];
  if (payload.filter) args.push(payload.filter);

  const { stdout } = await run(args);
  const packages = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^package:/, ""));
  return { count: packages.length, packages };
}

async function installHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as InstallPayload;
  if (!payload.apkPath) throw new Error('install requires "apkPath" in the task payload');

  const apkPath = path.resolve(payload.apkPath);
  if (!existsSync(apkPath)) throw new Error(`File not found at path: ${apkPath}`);

  const args = [...deviceArgs(payload), "install"];
  if (payload.reinstall) args.push("-r");
  args.push(apkPath);

  const { stdout, stderr } = await run(args);
  return { apkPath, stdoutTail: stdout.slice(-2000), stderrTail: stderr ? stderr.slice(-2000) : undefined };
}

async function uninstallHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as UninstallPayload;
  if (!payload.packageName) throw new Error('uninstall requires "packageName" in the task payload');

  const args = [...deviceArgs(payload), "uninstall"];
  if (payload.keepData) args.push("-k");
  args.push(payload.packageName);

  const { stdout, stderr } = await run(args);
  return {
    packageName: payload.packageName,
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr ? stderr.slice(-2000) : undefined,
  };
}

async function shellHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as ShellPayload;
  if (!payload.command) throw new Error('shell requires "command" in the task payload');

  const args = [...deviceArgs(payload), "shell", payload.command];
  const { stdout, stderr } = await run(args);
  return { command: payload.command, stdout: stdout.slice(-4000), stderr: stderr ? stderr.slice(-2000) : undefined };
}

async function logcatHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as LogcatPayload;
  const lineLimit = payload.lines && payload.lines > 0 ? payload.lines : 200;

  // "-d" dumps the current buffer and exits, rather than streaming live -
  // matches this Gateway's request/response Task model instead of needing
  // a persistent connection.
  const args = [...deviceArgs(payload), "logcat", "-d"];
  if (payload.filter) args.push(...payload.filter.split(/\s+/));

  const { stdout } = await run(args, 1024 * 1024 * 50);
  const allLines = stdout.split("\n");
  const tail = allLines.slice(-lineLimit);
  return { lineCount: tail.length, truncatedFrom: allLines.length, lines: tail };
}

async function pullHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as PullPayload;
  if (!payload.remotePath) throw new Error('pull requires "remotePath" in the task payload');

  const fileName = payload.fileName?.trim() || path.basename(payload.remotePath);
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    throw new Error('"fileName" must be a plain file name, not a path');
  }

  const destDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "adb", "pulled");
  await mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, fileName);

  const args = [...deviceArgs(payload), "pull", payload.remotePath, destPath];
  const { stdout, stderr } = await run(args);
  return {
    remotePath: payload.remotePath,
    localPath: destPath,
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr ? stderr.slice(-2000) : undefined,
  };
}

async function pushHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as PushPayload;
  if (!payload.localPath) throw new Error('push requires "localPath" in the task payload');
  if (!payload.remotePath) throw new Error('push requires "remotePath" in the task payload');

  const localPath = path.resolve(payload.localPath);
  if (!existsSync(localPath)) throw new Error(`File not found at path: ${localPath}`);

  const args = [...deviceArgs(payload), "push", localPath, payload.remotePath];
  const { stdout, stderr } = await run(args);
  return {
    localPath,
    remotePath: payload.remotePath,
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr ? stderr.slice(-2000) : undefined,
  };
}

export async function adbHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "devices":
      return devicesHandler();
    case "packages":
      return packagesHandler(task);
    case "install":
      return installHandler(task);
    case "uninstall":
      return uninstallHandler(task);
    case "shell":
      return shellHandler(task);
    case "logcat":
      return logcatHandler(task);
    case "pull":
      return pullHandler(task);
    case "push":
      return pushHandler(task);
    default:
      throw new Error(
        `Unsupported adb operation "${task.operation}". Supported: "devices", "packages", "install", "uninstall", "shell", "logcat", "pull", "push"`
      );
  }
}
