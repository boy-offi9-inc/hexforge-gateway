/**
 * The "PC-side equivalent of MT Manager's APK MCP" - on Android, the
 * `apkmcp` agent (see docs/AGENTS.md) lets an MT Manager user visually
 * pick an APK and hand its path over without typing it. A PC has no MT
 * Manager, so this is the same convenience by a different mechanism:
 * drop an .apk into a watched folder, and it gets claimed into its own
 * workspace automatically - no full path to type into a tool call at all.
 *
 * Poll-based on purpose, not `fs.watch()`. This project's own primary
 * environment is Android/Termux (see docs/SETUP.md), where `fs.watch`'s
 * inotify backing is genuinely unreliable - on scoped storage / SD cards
 * / synced folders it can miss events outright or fire duplicates in a
 * way that varies by device and Android version. A one-second poll costs
 * nothing a human would notice for "I just dropped a file" and behaves
 * identically everywhere: Android, a PC, a network share, doesn't matter.
 *
 * How a file gets "claimed": stat it, remember its size+mtime, and only
 * act on it once a *later* poll tick sees the exact same size+mtime -
 * i.e. it's stopped changing. That's what stands in for a filesystem's
 * own "write finished" signal, since neither poll-based nor even
 * inotify-based watching gives you that reliably across platforms (a
 * multi-GB APK copied over Wi-Fi can sit at a stable size for a moment
 * mid-transfer too, but two full poll intervals apart without a change
 * is a reasonable bar - a human dropping a file isn't racing a 1-second
 * window). Once claimed: the file is moved (not copied) into
 * `<WORKSPACES_ROOT>/<workspaceId>/inbox/<filename>` - "moved" so the
 * inbox folder doesn't silently accumulate every APK ever dropped into
 * it - and a knowledge entry records where it landed, so `list_knowledge`
 * or a chat turn can surface it without the AI needing to have watched
 * the drop happen. `GET /workspaces/:id/inbox` (workspace.routes.ts) and
 * the `get_inbox_apks` MCP tool are the actual "don't type the path"
 * payoff - both just list that same `inbox/` directory on disk, which is
 * the sole source of truth here on purpose: no separate record to drift
 * out of sync with what's actually on disk.
 */

import { mkdir, readdir, rename, copyFile, unlink, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../../core/config.js";
import * as workspaceService from "../workspace/workspace.service.js";
import * as knowledgeService from "../knowledge/knowledge.service.js";
import { detectConsoleCaps, notice } from "../../core/console-ui.js";

function log(...args: unknown[]) {
  notice("inbox-watcher", "info", args.map(String).join(" "));
}

/**
 * "MyApp-v2 (1).apk" -> "myapp-v2-1". Never returns an empty string - a
 * filename that sanitizes down to nothing (e.g. "???.apk") still needs a
 * usable workspace name, and repeated drops of literally the same
 * filename are expected to land in the same workspace on purpose (a
 * newer build of the same app you're already tracking), not fork a new
 * one every time.
 */
export function deriveWorkspaceNameFromFilename(fileName: string): string {
  const base = fileName.replace(/\.apk$/i, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "dropped-apk";
}

interface Seen {
  size: number;
  mtimeMs: number;
}

export class InboxWatcher {
  private timer: NodeJS.Timeout | undefined;
  private dir: string | undefined;
  private seen = new Map<string, Seen>();
  // Guards against a claim still being awaited (a slow move across
  // filesystems, a slow knowledge-entry write) when the next tick fires -
  // without this, two overlapping ticks could both try to claim and move
  // the same already-stable file.
  private claiming = new Set<string>();

  /** The folder being polled, or undefined while the watcher is off - what the startup banner shows. */
  get watching(): string | undefined {
    return this.dir;
  }

  start(): void {
    // On a terminal the startup banner already says whether the inbox is on
    // and where, so the two status lines below would only repeat it.
    const quiet = detectConsoleCaps().pretty;
    if (!config.APK_INBOX_DIR) {
      if (!quiet)
        log(
          "APK_INBOX_DIR not set - disabled. Set it to a folder to enable dropping APKs instead of typing full paths.",
        );
      return;
    }
    const resolved = path.resolve(config.APK_INBOX_DIR);
    this.dir = resolved;
    if (!quiet)
      log(`watching ${resolved} every ${config.APK_INBOX_POLL_MS}ms for dropped .apk files`);
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) =>
        log("poll tick failed:", err instanceof Error ? err.message : String(err)),
      );
    }, config.APK_INBOX_POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.dir = undefined;
  }

  /** One poll tick, exposed separately from start() so a test can drive it deterministically without real timers. */
  async runOnce(): Promise<void> {
    if (!config.APK_INBOX_DIR) return;
    const dir = path.resolve(config.APK_INBOX_DIR);

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        await mkdir(dir, { recursive: true });
        return; // nothing to scan yet, this tick just created the folder
      }
      throw err;
    }

    const apkFiles = new Set(entries.filter((f) => f.toLowerCase().endsWith(".apk")));

    // Stop tracking anything that's no longer there (removed externally
    // before it ever stabilized) so `seen` doesn't grow unbounded.
    for (const tracked of this.seen.keys()) {
      if (!apkFiles.has(tracked)) this.seen.delete(tracked);
    }

    for (const fileName of apkFiles) {
      if (this.claiming.has(fileName)) continue;

      const fullPath = path.join(dir, fileName);
      let info: Seen;
      try {
        const s = await stat(fullPath);
        if (!s.isFile()) continue; // e.g. a directory that happens to end in .apk
        info = { size: s.size, mtimeMs: s.mtimeMs };
      } catch {
        continue; // disappeared between readdir and stat - fine, next tick will just not see it
      }

      const previous = this.seen.get(fileName);
      if (previous && previous.size === info.size && previous.mtimeMs === info.mtimeMs) {
        this.seen.delete(fileName);
        this.claiming.add(fileName);
        try {
          await this.claim(fileName, fullPath);
        } catch (err) {
          log(`failed to claim ${fileName}:`, err instanceof Error ? err.message : String(err));
        } finally {
          this.claiming.delete(fileName);
        }
      } else {
        this.seen.set(fileName, info);
      }
    }
  }

  private async claim(fileName: string, sourcePath: string): Promise<void> {
    const workspaceName = deriveWorkspaceNameFromFilename(fileName);
    const workspace = await workspaceService.getOrCreateWorkspace(workspaceName, workspaceName);

    const destDir = path.resolve(config.WORKSPACES_ROOT, workspace.id, "inbox");
    await mkdir(destDir, { recursive: true });
    const destPath = path.join(destDir, fileName);

    try {
      await rename(sourcePath, destPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        // Inbox dir and WORKSPACES_ROOT are on different filesystems/
        // volumes - rename() can't do a cross-device move, fall back to
        // copy-then-delete.
        await copyFile(sourcePath, destPath);
        await unlink(sourcePath);
      } else {
        throw err;
      }
    }

    log(
      `claimed ${fileName} -> workspace "${workspaceName}" (${workspace.id}), moved to ${destPath}`,
    );

    await knowledgeService.createEntry({
      workspaceId: workspace.id,
      type: "note",
      title: `APK dropped: ${fileName}`,
      content: `Detected in the inbox folder and moved to ${destPath}.`,
      source: "inbox",
    });
  }
}

export const inboxWatcher = new InboxWatcher();

export interface InboxApk {
  fileName: string;
  path: string;
  sizeBytes: number;
  detectedAt: string;
}

/** Backs `GET /workspaces/:id/inbox` and the `get_inbox_apks` MCP tool - lists whatever's actually in this workspace's own inbox/ directory, newest first. No separate index to keep in sync; the directory is the truth. */
export async function listInboxApks(workspaceId: string): Promise<InboxApk[]> {
  const dir = path.resolve(config.WORKSPACES_ROOT, workspaceId, "inbox");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const apks: InboxApk[] = [];
  for (const fileName of entries) {
    if (!fileName.toLowerCase().endsWith(".apk")) continue;
    const fullPath = path.join(dir, fileName);
    const s = await stat(fullPath);
    if (!s.isFile()) continue;
    apks.push({
      fileName,
      path: fullPath,
      sizeBytes: s.size,
      detectedAt: s.mtime.toISOString(),
    });
  }
  return apks.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
}
