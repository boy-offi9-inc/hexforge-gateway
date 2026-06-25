import { parentPort, workerData } from "node:worker_threads";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Runs the actual walk+regex-match loop for filesystem.agent.ts's
 * "search" operation, inside a worker thread rather than the main event
 * loop. A single synchronous RegExp.test() call can't be interrupted once
 * started - if `pattern` triggers catastrophic backtracking, a plain
 * `await` timeout around the call does nothing, since the event loop
 * itself is blocked and can never fire the timeout. Running it in a
 * worker means the caller (filesystem.agent.ts) can `worker.terminate()`
 * it after a deadline no matter how stuck the regex engine is - the main
 * process and every other request stay responsive either way.
 */

const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const BINARY_LIKE_EXTENSIONS = new Set([
  ".apk", ".dex", ".zip", ".jar", ".so", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ttf", ".otf",
]);

interface SearchWorkerData {
  dirPath: string;
  pattern: string;
  caseSensitive?: boolean;
  extensions?: string[];
  maxResults: number;
}

async function run() {
  const data = workerData as SearchWorkerData;
  const regex = new RegExp(data.pattern, data.caseSensitive ? "g" : "gi");

  const results: { file: string; line: number; text: string }[] = [];
  let filesScanned = 0;
  let truncated = false;

  async function walk(current: string) {
    if (truncated) return;
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      if (truncated) return;
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        await walk(full);
        continue;
      }
      const ext = path.extname(item.name).toLowerCase();
      if (data.extensions && data.extensions.length > 0) {
        if (!data.extensions.includes(ext)) continue;
      } else if (BINARY_LIKE_EXTENSIONS.has(ext)) {
        continue;
      }

      const s = await stat(full);
      if (s.size > MAX_SEARCH_FILE_BYTES) continue;

      filesScanned++;
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push({ file: path.relative(data.dirPath, full), line: i + 1, text: lines[i].trim().slice(0, 300) });
          if (results.length >= data.maxResults) {
            truncated = true;
            break;
          }
        }
      }
    }
  }

  await walk(data.dirPath);
  parentPort?.postMessage({
    dirPath: data.dirPath,
    pattern: data.pattern,
    filesScanned,
    matchCount: results.length,
    matches: results,
    truncated,
  });
}

run().catch((err) => {
  parentPort?.postMessage({ __error: err instanceof Error ? err.message : String(err) });
});
