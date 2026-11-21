import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import * as moduleStore from "../../frida-modules/module-store.js";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { withSavedOutput } from "./task-output.js";
import { friendlyExecError, type ExecFailure } from "./shared/exec-error.js";

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
  script?: string; // raw Frida JS - written to a temp file under the workspace dir before running; or resolved from "moduleRef"
  moduleRef?: string; // a stored module: "name" (latest) or "name@version"
  timeoutSeconds?: number; // default 15, capped at 60 - how long to let the script run before killing it
}

const DEFAULT_REMOTE_SERVER_PATH = "/data/local/tmp/frida-server";
const DEFAULT_TIMEOUT_SECONDS = 15;
const MAX_TIMEOUT_SECONDS = 60;

// startServerHandler embeds remotePath inside a single-quoted `su -c '...'`
// string that's executed by the *device's* shell (adb ships it as one argv
// element, but the remote shell still parses it) - unlike pushServerHandler's
// use of remotePath as a plain adb argument, that interpolation is unsafe
// for arbitrary input. A remotePath containing a `'` (or `;`, `$`, etc.)
// could break out of the quoted string and run arbitrary commands as root
// on the device. Reject anything that isn't a plain absolute path before it
// ever reaches that string, mirroring the fileName checks adb.agent.ts's
// pull/push already do for the same reason.
function assertSafeRemotePath(remotePath: string): void {
  if (!remotePath.startsWith("/")) {
    throw new Error(`"remotePath" must be an absolute path on the device, got: ${remotePath}`);
  }
  if (/['"$`\\;&|(){}<>\n]/.test(remotePath)) {
    throw new Error(
      `"remotePath" contains characters that aren't safe to embed in a remote shell command: ${remotePath}`,
    );
  }
}

function deviceArgs(payload: DeviceScopedPayload): string[] {
  // "-U" (default USB device) is the common case for this project (an
  // Android phone/emulator); "-D <id>" targets a specific device from
  // "list-devices" when more than one is connected.
  return payload.deviceSerial ? ["-D", payload.deviceSerial] : ["-U"];
}

async function runAdb(args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("adb", args, { maxBuffer: 1024 * 1024 * 10 });
  } catch (err) {
    throw friendlyExecError(
      "adb",
      'Install frida-tools first: "pip install frida-tools" (needs Python). A frida-server matching that version also needs to be running on the target device - see this agent\'s docs.',
      err,
    );
  }
}

async function listDevicesHandler(): Promise<unknown> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("frida-ls-devices", [], {
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    throw friendlyExecError(
      "frida-ls-devices",
      'Install frida-tools first: "pip install frida-tools" (needs Python). A frida-server matching that version also needs to be running on the target device - see this agent\'s docs.',
      err,
    );
  }
  const lines = stdout
    .split("\n")
    .slice(2)
    .map((l) => l.trim())
    .filter(Boolean); // skip header + separator row
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
    ({ stdout } = await execFileAsync("frida-ps", args, {
      maxBuffer: 1024 * 1024 * 5,
    }));
  } catch (err) {
    throw friendlyExecError(
      "frida-ps",
      'Install frida-tools first: "pip install frida-tools" (needs Python). A frida-server matching that version also needs to be running on the target device - see this agent\'s docs.',
      err,
    );
  }

  const lines = stdout
    .split("\n")
    .slice(2)
    .map((l) => l.trim())
    .filter(Boolean);
  const processes = lines.map((line) => {
    const cols = line.split(/\s{2,}/);
    return payload.includeApps
      ? { pid: cols[0] || null, name: cols[1], identifier: cols[2] }
      : { pid: cols[0], name: cols[1] };
  });
  return { processes };
}

async function pushServerHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as PushServerPayload;
  if (!payload.localServerPath)
    throw new Error('push-server requires "localServerPath" in the task payload');

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
  assertSafeRemotePath(remotePath);
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
    note: 'Best-effort - requires root. Verify with a "list-devices" or "list-processes" call rather than trusting this alone.',
  };
}

async function stopServerHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as ServerControlPayload;
  const args = payload.deviceSerial ? ["-s", payload.deviceSerial] : [];

  const { stdout, stderr } = await runAdb([...args, "shell", "su -c 'pkill -f frida-server'"]);
  return {
    stopped: true,
    stdoutTail: stdout.slice(-500),
    stderrTail: stderr ? stderr.slice(-500) : undefined,
  };
}

async function traceHandler(task: McpTask): Promise<unknown> {
  let payload = { ...(task.payload as unknown as TracePayload) };
  if (!payload.target) throw new Error('trace requires "target" in the task payload');
  // script OR moduleRef: a moduleRef resolves to the store's script and
  // records the run as provenance on the module
  let moduleName: string | undefined;
  if (!payload.script) {
    if (!payload.moduleRef) {
      throw new Error(
        'trace requires "script" (raw Frida JS) or "moduleRef" (a stored module, "name" or "name@version")',
      );
    }
    const resolved = await moduleStore.resolveScript(payload.moduleRef);
    payload = { ...payload, script: resolved.script };
    moduleName = resolved.module.name;
  }
  if (!payload.script)
    throw new Error('trace requires "script" (raw Frida JS) in the task payload');

  const mode = payload.mode ?? "spawn";
  const timeoutSeconds =
    payload.timeoutSeconds && payload.timeoutSeconds > 0
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
    if (moduleName) {
      await moduleStore
        .recordTestRun(moduleName, { taskId: task.id, target: payload.target })
        .catch(
          () => {}, // provenance is best-effort; the trace result matters more
        );
    }
    return withSavedOutput(task, "frida/traces", {
      target: payload.target,
      mode,
      scriptPath,
      module: moduleName,
      timedOut: false,
      stdout,
      stderr,
    });
  } catch (err) {
    const failure = err as ExecFailure;
    if (failure?.killed && failure?.signal === "SIGTERM") {
      // Ran out of time, not a real failure - this is the expected way a
      // "trace" call ends, since the script has no way to signal "I'm
      // done" back to this agent. Whatever it emitted before the kill is
      // still real and useful.
      return withSavedOutput(task, "frida/traces", {
        target: payload.target,
        mode,
        scriptPath,
        timedOut: true,
        stdout: (failure.stdout ?? "").toString(),
        stderr: (failure.stderr ?? "").toString(),
      });
    }
    throw friendlyExecError(
      "frida",
      'Install frida-tools first: "pip install frida-tools" (needs Python). A frida-server matching that version also needs to be running on the target device - see this agent\'s docs.',
      err,
    );
  }
}

// ---- Module store: trace scripts as versioned, reusable assets ----

async function moduleSaveHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as { name?: string; script?: string; notes?: string };
  if (!payload.name) throw new Error('module-save requires "name"');
  if (!payload.script) throw new Error('module-save requires "script"');
  const draft = await moduleStore.saveDraft({
    name: payload.name,
    script: payload.script,
    notes: payload.notes,
  });
  return {
    module: {
      name: draft.name,
      status: draft.status,
      notes: draft.notes,
      updatedAt: draft.updatedAt,
    },
  };
}

async function modulePromoteHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as {
    name?: string;
    bump?: "patch" | "minor" | "major";
    notes?: string;
  };
  if (!payload.name) throw new Error('module-promote requires "name"');
  const published = await moduleStore.promote(payload.name, payload.bump ?? "patch", payload.notes);
  return {
    module: {
      name: published.name,
      version: published.version,
      status: published.status,
      notes: published.notes,
      testRuns: published.testRuns.length,
    },
    // use it in a trace via moduleRef: "<name>@<version>"
    usage: `trace with {"moduleRef": "${published.name}@${published.version}"}`,
  };
}

async function moduleListHandler(): Promise<unknown> {
  const modules = await moduleStore.listModules();
  return {
    modules: modules.map((m) => ({
      name: m.name,
      version: m.version,
      status: m.status,
      testRuns: m.testRuns.length,
      notes: m.notes,
      updatedAt: m.updatedAt,
    })),
  };
}

async function moduleGetHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as { name?: string; version?: string };
  if (!payload.name) throw new Error('module-get requires "name" (and optional "version")');
  const module = await moduleStore.getModule(payload.name, payload.version);
  if (!module)
    throw new Error(`No module "${payload.name}"${payload.version ? `@${payload.version}` : ""}`);
  return {
    module: {
      name: module.name,
      version: module.version,
      status: module.status,
      script: module.script,
      notes: module.notes,
      testRuns: module.testRuns,
    },
  };
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
    case "module-save":
      return moduleSaveHandler(task);
    case "module-promote":
      return modulePromoteHandler(task);
    case "module-list":
      return moduleListHandler();
    case "module-get":
      return moduleGetHandler(task);
    default:
      throw new Error(
        `Unsupported frida operation "${task.operation}". Supported: "list-devices", "list-processes", ` +
          `"push-server", "start-server", "stop-server", "trace", "module-save", "module-promote", ` +
          `"module-list", "module-get"`,
      );
  }
}
