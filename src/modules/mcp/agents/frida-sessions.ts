import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../../../core/config.js";

/**
 * Streaming Frida sessions: a long-running instrumentation run whose events
 * are appended to a per-session JSONL log the caller polls incrementally,
 * instead of "trace" bounded windows that die with the timeout.
 *
 * Sessions live in the daemon's memory - a restart drops them (the event
 * logs stay on disk, so what already streamed is never lost). Each session
 * belongs to exactly one workspace and one target, and is capped so an
 * orphaned run can't hold a device forever.
 */

/** Default cap for a streaming session, in seconds. */
export const DEFAULT_MAX_SECONDS = 300;
/** Hard ceiling regardless of what the caller asks for. */
export const MAX_SECONDS_CEILING = 1800;
/** Events kept in memory for a tail preview; the log file keeps everything. */
const PREVIEW_EVENTS = 50;

export type SessionState = "running" | "stopped" | "exited" | "timeout";

export interface StreamEvent {
  /** 1-based position in the session's event log. */
  seq: number;
  at: string;
  stream: "stdout" | "stderr";
  line: string;
}

export interface FridaSession {
  id: string;
  workspaceId: string;
  taskId: string;
  target: string;
  mode: "spawn" | "attach";
  deviceSerial?: string;
  /** JSONL event log inside the workspace. */
  eventsPath: string;
  state: SessionState;
  startedAt: string;
  endedAt?: string;
  /** How many events have been written so far. */
  eventCount: number;
  /** The process exit code/message once it has ended. */
  exit?: { code: number | null; signal: string | null };
  /** Last lines seen, for a cheap tail without reading the log. */
  preview: StreamEvent[];
}

interface LiveSession {
  session: FridaSession;
  child: ChildProcessByStdio<null, Readable, Readable>;
  timer: NodeJS.Timeout;
  log: ReturnType<typeof createWriteStream>;
}

const live = new Map<string, LiveSession>();

/** Sessions are per-workspace: an id from one workspace is invisible to another. */
function findLive(id: string, workspaceId: string): LiveSession | undefined {
  const entry = live.get(id);
  return entry && entry.session.workspaceId === workspaceId ? entry : undefined;
}

function serialize(entry: LiveSession): FridaSession {
  return { ...entry.session, preview: entry.session.preview.slice(-PREVIEW_EVENTS) };
}

function appendEvent(entry: LiveSession, stream: "stdout" | "stderr", line: string): void {
  const event: StreamEvent = {
    seq: entry.session.eventCount + 1,
    at: new Date().toISOString(),
    stream,
    line,
  };
  entry.session.eventCount = event.seq;
  entry.session.preview.push(event);
  if (entry.session.preview.length > PREVIEW_EVENTS * 2) {
    entry.session.preview = entry.session.preview.slice(-PREVIEW_EVENTS);
  }
  try {
    entry.log.write(`${JSON.stringify(event)}\n`);
  } catch {
    // A full disk loses the log line, never the session.
  }
}

function endSession(entry: LiveSession, state: SessionState): void {
  if (entry.session.state !== "running") return;
  entry.session.state = state;
  entry.session.endedAt = new Date().toISOString();
  clearTimeout(entry.timer);
  try {
    entry.log.end();
  } catch {
    // already closed
  }
}

/** Splits a stream chunk into lines, keeping partial trailing chunks for later. */
function lineSplitter(onLine: (line: string) => void) {
  let buffered = "";
  return (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let at: number;
    while ((at = buffered.indexOf("\n")) !== -1) {
      onLine(buffered.slice(0, at).replace(/\r$/, ""));
      buffered = buffered.slice(at + 1);
    }
  };
}

export interface StartOptions {
  workspaceId: string;
  taskId: string;
  target: string;
  mode: "spawn" | "attach";
  script: string;
  deviceSerial?: string;
  maxSeconds?: number;
  /** The binary to spawn; tests pass a fake. */
  binary?: string;
}

/**
 * Starts a streaming session. The caller gets an id immediately; events are
 * appended to `eventsPath` as the target emits them, and read back with
 * `pollSession`. The session is capped at `maxSeconds` (hard ceiling
 * MAX_SECONDS_CEILING) and ends itself when the process exits.
 */
export async function startSession(options: StartOptions): Promise<FridaSession> {
  const maxSeconds = Math.min(
    Math.max(options.maxSeconds ?? DEFAULT_MAX_SECONDS, 1),
    MAX_SECONDS_CEILING,
  );

  const dir = path.resolve(config.WORKSPACES_ROOT, options.workspaceId, "frida", "sessions");
  await mkdir(dir, { recursive: true });

  const id = `fs-${randomUUID().slice(0, 8)}`;
  const eventsPath = path.join(dir, `${id}.jsonl`);
  const scriptPath = path.join(dir, `${id}.js`);
  await mkdir(path.dirname(scriptPath), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(scriptPath, options.script, "utf8");

  const args: string[] = options.deviceSerial ? ["-D", options.deviceSerial] : ["-U"];
  if (options.mode === "spawn") {
    args.push("-f", options.target, "--no-pause");
  } else {
    args.push(/^\d+$/.test(options.target) ? "-p" : "-n", options.target);
  }
  args.push("-l", scriptPath, "-q");

  const child = spawn(options.binary ?? "frida", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const session: FridaSession = {
    id,
    workspaceId: options.workspaceId,
    taskId: options.taskId,
    target: options.target,
    mode: options.mode,
    deviceSerial: options.deviceSerial,
    eventsPath,
    state: "running",
    startedAt: new Date().toISOString(),
    eventCount: 0,
    preview: [],
  };

  const entry: LiveSession = {
    session,
    child,
    timer: setTimeout(() => {
      endSession(entry, "timeout");
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }, maxSeconds * 1000),
    log: createWriteStream(eventsPath, { flags: "a" }),
  };
  entry.timer.unref?.();
  live.set(id, entry);

  child.stdout.on(
    "data",
    lineSplitter((line) => appendEvent(entry, "stdout", line)),
  );
  child.stderr.on(
    "data",
    lineSplitter((line) => appendEvent(entry, "stderr", line)),
  );
  child.on("error", (err: Error) => {
    appendEvent(entry, "stderr", `[session error] ${err.message}`);
    endSession(entry, "exited");
  });
  child.on("close", (code: number | null, signal: string | null) => {
    entry.session.exit = { code, signal };
    endSession(entry, entry.session.state === "timeout" ? "timeout" : "exited");
  });

  return serialize(entry);
}

export interface PollResult {
  session: FridaSession;
  events: StreamEvent[];
  /** Pass back as `since` next time to continue exactly where this stopped. */
  nextSeq: number;
  ended: boolean;
}

/**
 * Reads events after `since` from the session's log. Polling a session that
 * is already gone (daemon restarted) still works as long as the log file is
 * there - the events are on disk, not in memory.
 */
export async function pollSession(
  id: string,
  workspaceId: string,
  since = 0,
  limit = 200,
): Promise<PollResult> {
  const entry = findLive(id, workspaceId);
  const session = entry ? serialize(entry) : await sessionFromLog(id, workspaceId);
  if (!session) throw new Error(`No streaming session "${id}" in this workspace`);

  let raw = "";
  if (existsSync(session.eventsPath)) {
    raw = await readFile(session.eventsPath, "utf8");
  }
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      continue; // a torn final line while the writer is mid-append
    }
    if (event.seq <= since) continue;
    if (events.length >= limit) break;
    events.push(event);
  }

  const last = events[events.length - 1];
  return {
    session,
    events,
    nextSeq: last ? last.seq : since,
    ended: session.state !== "running",
  };
}

/** Rebuilds a finished session's summary from its log, for after a restart. */
async function sessionFromLog(id: string, workspaceId: string): Promise<FridaSession | undefined> {
  const dir = path.resolve(config.WORKSPACES_ROOT, workspaceId, "frida", "sessions");
  const eventsPath = path.join(dir, `${id}.jsonl`);
  if (!existsSync(eventsPath)) return undefined;
  const raw = await readFile(eventsPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());
  let last: StreamEvent | undefined;
  let count = 0;
  for (const line of lines) {
    try {
      last = JSON.parse(line) as StreamEvent;
      count = last.seq;
    } catch {
      // skip torn lines
    }
  }
  return {
    id,
    workspaceId,
    taskId: "",
    target: "",
    mode: "attach",
    eventsPath,
    state: "exited",
    startedAt: "",
    eventCount: count,
    preview: last ? [last] : [],
  };
}

/** Stops a running session. Idempotent: stopping an ended session is a no-op. */
export async function stopSession(id: string, workspaceId: string): Promise<FridaSession> {
  const entry = findLive(id, workspaceId);
  if (!entry) {
    const fromLog = await sessionFromLog(id, workspaceId);
    if (!fromLog) throw new Error(`No streaming session "${id}" in this workspace`);
    return fromLog;
  }
  if (entry.session.state === "running") {
    endSession(entry, "stopped");
    try {
      entry.child.kill("SIGTERM");
    } catch {
      // already gone
    }
  }
  return serialize(entry);
}

/** Every session this workspace currently has running. */
export function listSessions(workspaceId: string): FridaSession[] {
  return [...live.values()].filter((e) => e.session.workspaceId === workspaceId).map(serialize);
}
