import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// A streaming session shells out to frida; these tests replace the child
// process with a fake EventEmitter pair so the lifecycle (start -> emit
// events -> poll incrementally -> stop/exit/timeout) can be driven anywhere,
// without a device.
let root: string;

/** A fake frida child: stdio pipes + close()/error()/kill semantics. */
function fakeChild() {
  const child = new EventEmitter() as unknown as EventEmitter & {
    stdout: Readable;
    stderr: Readable;
    kill: (signal?: string) => boolean;
  };
  const push = (stream: "stdout" | "stderr") => {
    const e = new EventEmitter();
    const r = new Readable({ read() {} });
    // route emitted chunks into the Readable
    (e as unknown as { write: (s: string) => void }).write = (s: string) => r.push(s);
    Object.assign(child, { [stream]: r });
    return e as unknown as { write: (s: string) => void };
  };
  const stdout = push("stdout");
  const stderr = push("stderr");
  let killed = false;
  child.kill = () => {
    killed = true;
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  return { child, stdout, stderr, killed: () => killed };
}

type Harness = ReturnType<typeof fakeChild>;
let harnesses: Harness[];

/** Loads the module with spawn replaced by a fake that emits the given lines. */
async function load(scriptLines: string[] = []) {
  vi.resetModules();
  vi.stubEnv("WORKSPACES_ROOT", path.join(root, "workspaces"));
  harnesses = [];
  vi.doMock("node:child_process", () => ({
    spawn: vi.fn(() => {
      const h = fakeChild();
      harnesses.push(h);
      queueMicrotask(() => {
        for (const line of scriptLines) h.stdout.write(`${line}\n`);
      });
      return h.child;
    }),
  }));
  return import("../src/modules/mcp/agents/frida-sessions.js");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hexforge-fs-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  await rm(root, { recursive: true, force: true });
});

import type { EventEmitter as EE } from "node:events";

const start = async (
  sessions: typeof import("../src/modules/mcp/agents/frida-sessions.js"),
  over: Record<string, unknown> = {},
) =>
  sessions.startSession({
    workspaceId: "ws1",
    taskId: "t1",
    target: "com.acme.app",
    mode: "spawn",
    script: "Java.perform(() => {});",
    ...over,
  });

describe("frida streaming sessions", () => {
  it("starts a session, streams events to a JSONL log, and previews them", async () => {
    const sessions = await load(["hello from hook", "second line"]);
    const session = await start(sessions);
    await vi.waitFor(async () => {
      const p = await sessions.pollSession(session.id, "ws1");
      expect(p.session.eventCount).toBe(2);
    });

    expect(session.id).toMatch(/^fs-/);
    expect(session.state).toBe("running");
    expect(session.eventsPath.endsWith(".jsonl")).toBe(true);

    const poll = await sessions.pollSession(session.id, "ws1");
    expect(poll.events.map((e) => e.line)).toEqual(["hello from hook", "second line"]);
    expect(poll.events[0].seq).toBe(1);
    expect(poll.nextSeq).toBe(2);
    expect(poll.ended).toBe(false);

    const logged = await readFile(session.eventsPath, "utf8");
    expect(logged.split("\n").filter(Boolean)).toHaveLength(2);
    expect(() => JSON.parse(logged.split("\n")[0])).not.toThrow();
  });

  it("polls incrementally with since, continuing exactly where it stopped", async () => {
    const sessions = await load(["a", "b"]);
    const session = await start(sessions);
    await vi.waitFor(async () => {
      const p = await sessions.pollSession(session.id, "ws1");
      expect(p.session.eventCount).toBe(2);
    });

    const first = await sessions.pollSession(session.id, "ws1", 0, 1);
    expect(first.events.map((e) => e.line)).toEqual(["a"]);
    expect(first.nextSeq).toBe(1);

    const second = await sessions.pollSession(session.id, "ws1", first.nextSeq);
    expect(second.events.map((e) => e.line)).toEqual(["b"]);
    expect(second.nextSeq).toBe(2);
  });

  it("ends the session when the process exits, keeping the events", async () => {
    const sessions = await load(["event before death"]);
    const session = await start(sessions);
    await vi.waitFor(async () => {
      const p = await sessions.pollSession(session.id, "ws1");
      expect(p.session.eventCount).toBe(1);
    });

    harnesses[0].child.emit("close", 0, null);
    await vi.waitFor(async () => {
      const poll = await sessions.pollSession(session.id, "ws1");
      expect(poll.ended).toBe(true);
    });
    const poll = await sessions.pollSession(session.id, "ws1");
    expect(poll.session.state).toBe("exited");
    expect(poll.session.exit).toEqual({ code: 0, signal: null });
    expect(poll.events.map((e) => e.line)).toEqual(["event before death"]);
  });

  it("kills the process and marks timeout when maxSeconds elapses", async () => {
    vi.useFakeTimers();
    const sessions = await load();
    const session = await start(sessions, { maxSeconds: 5 });
    // eslint-disable-next-line @typescript-eslint/no-confusing-void-expression
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harnesses[0].killed()).toBe(true);
    const poll = await sessions.pollSession(session.id, "ws1");
    expect(poll.session.state).toBe("timeout");
    vi.useRealTimers();
  });

  it("stop marks the session stopped, kills the child, and is idempotent", async () => {
    const sessions = await load(["one"]);
    const session = await start(sessions);
    await vi.waitFor(async () => {
      const p = await sessions.pollSession(session.id, "ws1");
      expect(p.session.eventCount).toBe(1);
    });

    const stopped = await sessions.stopSession(session.id, "ws1");
    expect(stopped.state).toBe("stopped");
    expect(harnesses[0].killed()).toBe(true);

    const again = await sessions.stopSession(session.id, "ws1");
    expect(again.state).toBe("stopped");
  });

  it("stops a spawn-mode session with -f and an attach with -n/-p", async () => {
    const sessions = await load();
    await start(sessions, { mode: "spawn", target: "com.acme" });
    await start(sessions, { mode: "attach", target: "1234" });
    const { spawn } = await import("node:child_process");
    const args = (spawn as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[1] as string[],
    );
    expect(args[0]).toContain("-f");
    expect(args[0]).toContain("com.acme");
    expect(args[1]).toContain("-p");
    expect(args[1]).toContain("1234");
  });

  it("sessions are workspace-scoped: another workspace sees nothing", async () => {
    const sessions = await load(["x"]);
    const session = await start(sessions);
    await expect(sessions.pollSession(session.id, "ws2")).rejects.toThrow(/No streaming session/);
    await expect(sessions.stopSession(session.id, "ws2")).rejects.toThrow(/No streaming session/);
    expect(sessions.listSessions("ws2")).toEqual([]);
    expect(sessions.listSessions("ws1").map((s) => s.id)).toEqual([session.id]);
  });

  it("a session whose daemon died is still pollable from its log", async () => {
    const first = await load(["kept event"]);
    const session = await start(first);
    await vi.waitFor(async () => {
      const p = await first.pollSession(session.id, "ws1");
      expect(p.session.eventCount).toBe(1);
    });

    // simulate a restart: fresh module state, same disk
    const second = await load();
    const poll = await second.pollSession(session.id, "ws1");
    expect(poll.ended).toBe(true);
    expect(poll.session.state).toBe("exited");
    expect(poll.events.map((e) => e.line)).toEqual(["kept event"]);
  });

  it("rejects unknown session ids instead of guessing", async () => {
    const sessions = await load();
    await expect(sessions.pollSession("fs-nope", "ws1")).rejects.toThrow(/No streaming session/);
  });
});
