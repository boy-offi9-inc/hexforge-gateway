import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// WORKSPACES_ROOT/APK_INBOX_DIR are fixed at config import time (same
// situation as local-storage.provider.test.ts's DATA_DIR), so each test
// gets fresh temp dirs and a fresh module registry. workspace.service.js
// and knowledge.service.js are mocked one layer down, same approach as
// job-engine.test.ts mocking orchestrator.js - this file only wants to
// verify the watcher's own stability-detection/move/list logic, not
// re-exercise workspace or knowledge persistence.
vi.mock("../src/modules/workspace/workspace.service.js", () => ({
  getOrCreateWorkspace: vi.fn(async (name: string, targetLabel: string) => ({
    id: `ws-${name}`,
    name,
    targetLabel,
    status: "idle",
    createdAt: "",
    updatedAt: "",
  })),
}));
vi.mock("../src/modules/knowledge/knowledge.service.js", () => ({
  createEntry: vi.fn(async (input: unknown) => input),
}));

type InboxWatcherModule = typeof import("../src/modules/inbox/inbox-watcher.js");

let inboxDir: string;
let workspacesRoot: string;
let mod: InboxWatcherModule;
let watcher: InstanceType<InboxWatcherModule["InboxWatcher"]>;

beforeEach(async () => {
  inboxDir = await mkdtemp(path.join(tmpdir(), "hexforge-inbox-"));
  workspacesRoot = await mkdtemp(path.join(tmpdir(), "hexforge-workspaces-"));
  // vi.resetModules() clears the *module* cache (so config and the
  // watcher re-read the env below) but NOT the vi.mock() factories'
  // results - the same vi.fn() instances are handed back every time, so
  // call history from earlier tests in this file would leak into later
  // assertions ("called once" becomes "called 3 times"). clearAllMocks()
  // wipes just the call history. It has to be clear, not reset/restore:
  // those strip the async implementations the factories above define,
  // which crashes the next claim (same trap as job-engine.test.ts).
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubEnv("APK_INBOX_DIR", inboxDir);
  vi.stubEnv("WORKSPACES_ROOT", workspacesRoot);
  vi.stubEnv("APK_INBOX_POLL_MS", "1000");
  mod = await import("../src/modules/inbox/inbox-watcher.js");
  watcher = new mod.InboxWatcher();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(inboxDir, { recursive: true, force: true });
  await rm(workspacesRoot, { recursive: true, force: true });
});

describe("deriveWorkspaceNameFromFilename", () => {
  it("slugifies a filename and strips the .apk extension", async () => {
    expect(mod.deriveWorkspaceNameFromFilename("MyApp-v2 (1).apk")).toBe("myapp-v2-1");
  });

  it("falls back to a fixed name when sanitizing leaves nothing usable", async () => {
    expect(mod.deriveWorkspaceNameFromFilename("???.apk")).toBe("dropped-apk");
  });

  it("is case-insensitive about the .apk extension", async () => {
    expect(mod.deriveWorkspaceNameFromFilename("Foo.APK")).toBe("foo");
  });
});

describe("InboxWatcher.runOnce", () => {
  it("does not claim a file on its first sighting - only once a later tick sees it unchanged", async () => {
    await writeFile(path.join(inboxDir, "app.apk"), "fake apk bytes");

    await watcher.runOnce();
    const { getOrCreateWorkspace } = await import("../src/modules/workspace/workspace.service.js");
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();

    await watcher.runOnce();
    expect(getOrCreateWorkspace).toHaveBeenCalledWith("app", "app");
  });

  it("moves the file into <WORKSPACES_ROOT>/<workspaceId>/inbox/ and removes it from the inbox dir", async () => {
    const srcPath = path.join(inboxDir, "app.apk");
    await writeFile(srcPath, "fake apk bytes");

    await watcher.runOnce();
    await watcher.runOnce();

    const destPath = path.join(workspacesRoot, "ws-app", "inbox", "app.apk");
    await expect(stat(destPath)).resolves.toBeDefined();
    await expect(stat(srcPath)).rejects.toThrow();
  });

  it("writes exactly one knowledge entry, sourced \"inbox\", for the claimed file", async () => {
    await writeFile(path.join(inboxDir, "app.apk"), "fake apk bytes");
    await watcher.runOnce();
    await watcher.runOnce();

    const { createEntry } = await import("../src/modules/knowledge/knowledge.service.js");
    expect(createEntry).toHaveBeenCalledOnce();
    expect(createEntry).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-app", type: "note", source: "inbox" })
    );
  });

  it("does not claim a file that's still changing between polls (still being written/copied)", async () => {
    const growingPath = path.join(inboxDir, "growing.apk");
    await writeFile(growingPath, "part1");
    await watcher.runOnce(); // first sighting

    await appendFile(growingPath, "-more-bytes-written-later");
    await watcher.runOnce(); // size changed since last tick - must not claim yet

    const { getOrCreateWorkspace } = await import("../src/modules/workspace/workspace.service.js");
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();

    await watcher.runOnce(); // now unchanged since the previous tick - claim
    expect(getOrCreateWorkspace).toHaveBeenCalledWith("growing", "growing");
  });

  it("stops tracking a file that disappears before it ever stabilizes, without throwing", async () => {
    const flakyPath = path.join(inboxDir, "flaky.apk");
    await writeFile(flakyPath, "x");
    await watcher.runOnce(); // first sighting
    await unlink(flakyPath);

    await expect(watcher.runOnce()).resolves.toBeUndefined();

    const { getOrCreateWorkspace } = await import("../src/modules/workspace/workspace.service.js");
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();
  });

  it("creates the inbox directory on its first tick rather than throwing when it doesn't exist yet", async () => {
    await rm(inboxDir, { recursive: true, force: true });

    await expect(watcher.runOnce()).resolves.toBeUndefined();
    await expect(stat(inboxDir)).resolves.toBeDefined();
  });

  it("ignores non-.apk files entirely", async () => {
    await writeFile(path.join(inboxDir, "readme.txt"), "not an apk");
    await watcher.runOnce();
    await watcher.runOnce();

    const { getOrCreateWorkspace } = await import("../src/modules/workspace/workspace.service.js");
    expect(getOrCreateWorkspace).not.toHaveBeenCalled();
  });
});

describe("listInboxApks", () => {
  it("lists whatever .apk files actually landed in a workspace's inbox dir, newest first", async () => {
    const wsInbox = path.join(workspacesRoot, "ws-app", "inbox");
    await writeFile(path.join(inboxDir, "app.apk"), "fake apk bytes");
    await watcher.runOnce();
    await watcher.runOnce();

    const apks = await mod.listInboxApks("ws-app");
    expect(apks).toHaveLength(1);
    expect(apks[0]).toMatchObject({ fileName: "app.apk", path: path.join(wsInbox, "app.apk"), sizeBytes: "fake apk bytes".length });
  });

  it("returns an empty list, not an error, for a workspace with no inbox activity yet", async () => {
    await expect(mod.listInboxApks("ws-never-touched")).resolves.toEqual([]);
  });
});
