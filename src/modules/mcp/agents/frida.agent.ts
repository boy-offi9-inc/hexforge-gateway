import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";

const execFileAsync = promisify(execFile);

/**
 * Frida is fundamentally an interactive/streaming tool - attach, inject,
 * watch hook events happen live for as long as you want. This Gateway is
 * request/response. Rather than fake a real session, "trace" spawns or
 * attaches, injects a script, captures whatever it emits within a bounded
 * window, then kills it - the same "dump and stop" compromise
 * adb.agent.ts's `logcat` already makes for the same reason. If you need
 * a genuine interactive session, use the `frida` CLI directly; this agent
 * is for "run this hook for N seconds and tell me what happened".
 *
 * Requires:
 * - `frida-tools` on PATH (`pip install frida-tools`) - gives you the
 *   `frida`, `frida-ps`, `frida-ls-devices` binaries this agent shells out to.
 * - A `frida-server` running on the target device, matching your
 *   frida-tools version (version mismatches between client and server are
 *   the single most common Frida failure - check `frida --version` against
 *   whatever frida-server binary you're running). `push-server`/
 *   `start-server`/`stop-server` below assume a *rooted* device or
 *   emulator; non-root setups need Frida's Gadget-based injection
 *   instead, which this agent doesn't implement.
 */

interface DeviceScopedPayload {
  deviceSerial?: string; // frida device id from "list-devices" - omit for the default USB device
}

interface ListProcessesPayload extends DeviceScopedPayload {
  includeApps?: boolean; // frida-ps -a - lists installed apps (with identifiers), not just running processes
}

interface PushServerPayload extends DeviceScopedPayload {
  localServerPath: string; // a frida-server binary matching the device's arch + your frida-tools version
  remotePath?: string; // default /data/local/tmp/frida-server
}

interface ServerControlPayload extends DeviceScopedPayload {
  remotePath?: string; // default /data/local/tmp/frida-server
}

interface TracePayload extends DeviceScopedPayload {
  target: string; // package name (spawn mode) or PID/process name (attach mode)
  mode?: "spawn" | "attach"; // default "spawn"
  script: string; // raw Frida JS - written to a temp file under the workspace dir before running
  timeoutSeconds?: number; // default 15, capped at 60 - how long to let the script run before killing it
}

const DEFAULT_REMOTE_SERVER_PATH = "/data/local/tmp/frida-server";
const DEFAULT_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 60;

function deviceArgs(payload: DeviceScopedPayload): string[] {
  // "-U" (default USB device) is the common case for this project (an
  // Android phone/emulator); "-D <id>" targets a specific device from
  // "list-devices" when more than one is connected.
  return payload.deviceSerial ? ["-D", payload.deviceSerial] : ["-U"];
}

function friendlyFridaError(binary: string, err: any): Error {
  if (err?.code === "ENOENT") {
    return new Error(
      `"${binary}" not found on PATH. Install frida-tools first: "pip install frida-tools" (needs Python). ` +
        "A frida-server matching that version also needs to be running on the target device - see this agent's docs."
    );
  }
  const detail = (err?.stderr || err?.stdout || "").toString().trim().slice(-2000);
  const baseMessage = err instanceof Error ? err.message : String(err);
  return new Error(detail ? `${binary} failed: ${baseMessage}\n\n${detail}` : `${binary} failed: ${baseMessage}`);
}

async function runAdb(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("adb", args, { maxBuffer: 1024 * 1024 * 10 });
  } catch (err) {
    throw friendlyFridaError("adb", err);
  }
}

async function listDevicesHandler(): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("frida-ls-devices", [], { maxBuffer: 1024 * 1024 }));
  } catch (err) {
    throw friendlyFridaError("frida-ls-devices", err);
  }
  const lines = stdout.split("\n").slice(2).map((l) => l.trim()).filter(Boolean); // skip header + separator row
  const devices = lines.map((line) => {
    const cols = line.split(/\s{2,}/);
    return { id: cols[0], type: cols[1], name: cols[2] };
  });
  return { devices };
}

async function listProcessesHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as ListProcessesPayload;
  const args = [...deviceArgs(payload)];
  if (payload.includeApps) args.push("-a");

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("frida-ps", args, { maxBuffer: 1024 * 1024 * 5 }));
  } catch (err) {
    throw friendlyFridaError("frida-ps", err);
  }

  const lines = stdout.split("\n").slice(2).map((l) => l.trim()).filter(Boolean);
  const processes = lines.map((line) => {
    const cols = line.split(/\s{2,}/);
    return payload.includeApps
      ? { pid: cols[0] || null, name: cols[1], identifier: cols[2] }
      : { pid: cols[0], name: cols[1] };
  });
  return { processes };
}

async function pushServerHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as PushServerPayload;
  if (!payload.localServerPath) throw new Error('push-server requires "localServerPath" in the task payload');

  const localPath = path.resolve(payload.localServerPath);
  if (!existsSync(localPath)) throw new Error(`File not found at path: ${localPath}`);

  const remotePath = payload.remotePath ?? DEFAULT_REMOTE_SERVER_PATH;
  const args = payload.deviceSerial ? ["-s", payload.deviceSerial] : [];

  await runAdb([...args, "push", localPath, remotePath]);
  await runAdb([...args, "shell", "chmod", "755", remotePath]);

  return { localPath, remotePath, pushed: true };
}

async function startServerHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as ServerControlPayload;
  const remotePath = payload.remotePath ?? DEFAULT_REMOTE_SERVER_PATH;
  const args = payload.deviceSerial ? ["-s", payload.deviceSerial] : [];

  // Requires root. Backgrounding a process over a single adb shell
  // invocation is notoriously fragile (the child can die when the shell
  // connection closes) - nohup + redirected output is the common
  // workaround, but this varies by device/ROM and isn't guaranteed.
  const command = `su -c 'nohup ${remotePath} > /dev/null 2>&1 &'`;
  const { stdout, stderr } = await runAdb([...args, "shell", command]);

  return {
    remotePath,
    stdoutTail: stdout.slice(-1000),
    stderrTail: stderr ? stderr.slice(-1000) : undefined,
    note: "Best-effort - requires root. Verify with a \"list-devices\" or \"list-processes\" call rather than trusting this alone.",
  };
}

async function stopServerHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as ServerControlPayload;
  const args = payload.deviceSerial ? ["-s", payload.deviceSerial] : [];

  const { stdout, stderr } = await runAdb([...args, "shell", "su -c 'pkill -f frida-server'"]);
  return { stopped: true, stdoutTail: stdout.slice(-500), stderrTail: stderr ? stderr.slice(-500) : undefined };
}

async function traceHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as TracePayload;
  if (!payload.target) throw new Error('trace requires "target" in the task payload');
  if (!payload.script) throw new Error('trace requires "script" (raw Frida JS) in the task payload');

  const mode = payload.mode ?? "spawn";
  const timeoutSeconds = payload.timeoutSeconds && payload.timeoutSeconds > 0
    ? Math.min(payload.timeoutSeconds, MAX_TIMEOUT_SECONDS)
    : DEFAULT_TIMEOUT_SECONDS;

  const scriptsDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "frida", "scripts");
  await mkdir(scriptsDir, { recursive: true });
  const scriptPath = path.join(scriptsDir, `${Date.now()}.js`);
  await writeFile(scriptPath, payload.script, "utf8");

  const args = [...deviceArgs(payload)];
  if (mode === "spawn") {
    args.push("-f", payload.target, "--no-pause");
  } else {
    // Attach mode: numeric target is a PID, otherwise treat it as a process name.
    args.push(/^\d+$/.test(payload.target) ? "-p" : "-n", payload.target);
  }
  args.push("-l", scriptPath, "-q");

  try {
    const { stdout, stderr } = await execFileAsync("frida", args, {
      timeout: timeoutSeconds * 1000,
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024 * 10,
    });
    return { target: payload.target, mode, scriptPath, timedOut: false, stdout, stderr };
  } catch (err: any) {
    if (err?.killed && err?.signal === "SIGTERM") {
      // Ran out of time, not a real failure - this is the expected way a
      // "trace" call ends, since the script has no way to signal "I'm
      // done" back to this agent. Whatever it emitted before the kill is
      // still real and useful.
      return {
        target: payload.target,
        mode,
        scriptPath,
        timedOut: true,
        stdout: (err.stdout ?? "").toString(),
        stderr: (err.stderr ?? "").toString(),
      };
    }
    throw friendlyFridaError("frida", err);
  }
}

export async function fridaHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "list-devices":
      return listDevicesHandler();
    case "list-processes":
      return listProcessesHandler(task);
    case "push-server":
      return pushServerHandler(task);
    case "start-server":
      return startServerHandler(task);
    case "stop-server":
      return stopServerHandler(task);
    case "trace":
      return traceHandler(task);
    default:
      throw new Error(
        `Unsupported frida operation "${task.operation}". Supported: "list-devices", "list-processes", ` +
          `"push-server", "start-server", "stop-server", "trace"`
      );
  }
}
