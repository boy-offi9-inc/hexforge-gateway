import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";

// Trust model: "list"/"read"/"stat"/"search" accept any absolute path,
// same as jadx/apktool already trust an arbitrary "apkPath" - this is a
// local, single-user dev tool, and browsing a decompiled output dir
// anywhere on disk is the whole point of this agent. "write"/"delete" are
// destructive, so they're sandboxed to the calling workspace's own
// directory under WORKSPACES_ROOT rather than trusting any path. If this
// Gateway is ever exposed beyond localhost, add auth + real path
// sandboxing before relying on this distinction for anything.

const MAX_READ_BYTES = 512 * 1024; // 512KB - past this, read in chunks yourself or use "stat" first
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_RESULTS = 200;
// A pathological regex (catastrophic backtracking) can hang a single
// RegExp.test() call indefinitely, and JS can't interrupt a synchronous
// call once started - see filesystem.search.worker.ts for why this runs
// in a worker thread instead of inline.
const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_WORKER_PATH = fileURLToPath(new URL("./filesystem.search.worker.js", import.meta.url));

interface ListPayload {
  dirPath: string;
  recursive?: boolean;
  limit?: number;
}

interface ReadPayload {
  filePath: string;
  encoding?: "utf8" | "base64";
}

interface WritePayload {
  filePath: string;
  content: string;
  encoding?: "utf8" | "base64";
}

interface DeletePayload {
  filePath: string;
}

interface StatPayload {
  filePath: string;
}

interface SearchPayload {
  dirPath: string;
  pattern: string;
  caseSensitive?: boolean;
  extensions?: string[]; // e.g. [".java", ".xml"] - if omitted, searches all non-binary-looking files
  maxResults?: number;
}

function assertWithinWorkspace(filePath: string, workspaceId: string): string {
  const workspaceRoot = path.resolve(config.WORKSPACES_ROOT, workspaceId);
  const resolved = path.resolve(filePath);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw new Error(
      `Refusing to write/delete outside this workspace's directory (${workspaceRoot}). ` +
        `Got: ${resolved}. Reads/lists/search aren't restricted this way - only destructive operations are.`
    );
  }
  return resolved;
}

async function listHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as ListPayload;
  if (!payload.dirPath) throw new Error('list requires "dirPath" in the task payload');

  const dirPath = path.resolve(payload.dirPath);
  if (!existsSync(dirPath)) throw new Error(`Directory not found at path: ${dirPath}`);

  const limit = payload.limit && payload.limit > 0 ? Math.min(payload.limit, MAX_LIST_ENTRIES) : MAX_LIST_ENTRIES;
  const entries: { path: string; isDirectory: boolean; size: number }[] = [];
  let truncated = false;

  async function walk(current: string) {
    if (entries.length >= limit) {
      truncated = true;
      return;
    }
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      const full = path.join(current, item.name);
      const rel = path.relative(dirPath, full);
      if (item.isDirectory()) {
        entries.push({ path: rel, isDirectory: true, size: 0 });
        if (payload.recursive) await walk(full);
      } else {
        const s = await stat(full);
        entries.push({ path: rel, isDirectory: false, size: s.size });
      }
    }
  }

  await walk(dirPath);
  return { dirPath, count: entries.length, entries, truncated };
}

async function readHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as ReadPayload;
  if (!payload.filePath) throw new Error('read requires "filePath" in the task payload');

  const filePath = path.resolve(payload.filePath);
  if (!existsSync(filePath)) throw new Error(`File not found at path: ${filePath}`);

  const s = await stat(filePath);
  if (s.isDirectory()) throw new Error(`"${filePath}" is a directory, not a file - use "list" instead`);

  const encoding = payload.encoding ?? "utf8";
  const truncated = s.size > MAX_READ_BYTES;
  const buffer = await readFile(filePath);
  const slice = truncated ? buffer.subarray(0, MAX_READ_BYTES) : buffer;

  return {
    filePath,
    size: s.size,
    truncated,
    encoding,
    content: encoding === "base64" ? slice.toString("base64") : slice.toString("utf8"),
  };
}

async function writeHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as WritePayload;
  if (!payload.filePath) throw new Error('write requires "filePath" in the task payload');
  if (payload.content === undefined) throw new Error('write requires "content" in the task payload');

  const filePath = assertWithinWorkspace(payload.filePath, task.workspaceId);
  await mkdir(path.dirname(filePath), { recursive: true });

  const encoding = payload.encoding ?? "utf8";
  const buffer = encoding === "base64" ? Buffer.from(payload.content, "base64") : Buffer.from(payload.content, "utf8");
  await writeFile(filePath, buffer);

  return { filePath, bytesWritten: buffer.length };
}

async function deleteHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as DeletePayload;
  if (!payload.filePath) throw new Error('delete requires "filePath" in the task payload');

  const filePath = assertWithinWorkspace(payload.filePath, task.workspaceId);
  if (!existsSync(filePath)) return { filePath, deleted: false, reason: "did not exist" };

  await rm(filePath, { recursive: true, force: true });
  return { filePath, deleted: true };
}

async function statHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as StatPayload;
  if (!payload.filePath) throw new Error('stat requires "filePath" in the task payload');

  const filePath = path.resolve(payload.filePath);
  if (!existsSync(filePath)) return { filePath, exists: false };

  const s = await stat(filePath);
  return {
    filePath,
    exists: true,
    isDirectory: s.isDirectory(),
    size: s.size,
    modifiedAt: s.mtime.toISOString(),
  };
}

interface SearchWorkerResult {
  dirPath: string;
  filesScanned: number;
  matchCount: number;
  matches: { file: string; line: number; text: string; name: string }[];
  truncated: boolean;
}

function runSearchWorker(data: {
  dirPath: string;
  pattern?: string;
  patterns?: { name: string; pattern: string }[];
  caseSensitive?: boolean;
  extensions?: string[];
  maxResults: number;
}): Promise<SearchWorkerResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SEARCH_WORKER_PATH, { workerData: data });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(
        new Error(
          `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s - the pattern may be catastrophically slow ` +
            `(e.g. nested quantifiers like "(a+)+"). Try a simpler or more specific pattern.`
        )
      );
    }, SEARCH_TIMEOUT_MS);

    worker.once("message", (msg: SearchWorkerResult | { __error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if ("__error" in msg) reject(new Error(msg.__error));
      else resolve(msg);
    });

    worker.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function searchHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as SearchPayload;
  if (!payload.dirPath) throw new Error('search requires "dirPath" in the task payload');
  if (!payload.pattern) throw new Error('search requires "pattern" in the task payload');

  const dirPath = path.resolve(payload.dirPath);
  if (!existsSync(dirPath)) throw new Error(`Directory not found at path: ${dirPath}`);

  // Validate the pattern compiles before paying for a worker spin-up -
  // an invalid regex should fail fast with a clear message, not a
  // generic worker error.
  try {
    new RegExp(payload.pattern);
  } catch (err) {
    throw new Error(`Invalid search pattern (regex): ${err instanceof Error ? err.message : String(err)}`);
  }

  const maxResults = payload.maxResults && payload.maxResults > 0 ? Math.min(payload.maxResults, MAX_SEARCH_RESULTS) : MAX_SEARCH_RESULTS;

  return runSearchWorker({
    dirPath,
    pattern: payload.pattern,
    caseSensitive: payload.caseSensitive,
    extensions: payload.extensions,
    maxResults,
  });
}

// Curated, high-precision patterns - deliberately not exhaustive. These
// favor patterns with a distinctive enough shape to keep false positives
// low (a real AWS key prefix, a real PEM header) over generic ones like
// "password=..." that would flood results with test fixtures and config
// examples. This is a starting set for catching obvious hardcoded
// secrets before shipping/committing something, not a replacement for a
// maintained secret-scanning tool (gitleaks, trufflehog) for anything
// that actually matters.
const SECRET_PATTERNS: { name: string; pattern: string }[] = [
  { name: "AWS Access Key", pattern: "AKIA[0-9A-Z]{16}" },
  { name: "Google API Key", pattern: "AIza[0-9A-Za-z\\-_]{35}" },
  { name: "Private Key Header", pattern: "-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----" },
  { name: "Slack Token", pattern: "xox[baprs]-[0-9A-Za-z-]{10,48}" },
  { name: "GitHub Token", pattern: "gh[pousr]_[A-Za-z0-9]{36,255}" },
  { name: "Stripe Live Key", pattern: "sk_live_[0-9a-zA-Z]{24,}" },
  { name: "JWT", pattern: "eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}" },
  { name: "Firebase Cloud Messaging Key", pattern: "AAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140}" },
];

interface ScanSecretsPayload {
  dirPath: string;
  extensions?: string[];
  maxResults?: number;
}

async function scanSecretsHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as ScanSecretsPayload;
  if (!payload.dirPath) throw new Error('scan-secrets requires "dirPath" in the task payload');

  const dirPath = path.resolve(payload.dirPath);
  if (!existsSync(dirPath)) throw new Error(`Directory not found at path: ${dirPath}`);

  const maxResults = payload.maxResults && payload.maxResults > 0 ? Math.min(payload.maxResults, MAX_SEARCH_RESULTS) : MAX_SEARCH_RESULTS;

  return runSearchWorker({
    dirPath,
    patterns: SECRET_PATTERNS,
    caseSensitive: true, // these patterns rely on specific casing (AKIA, AIza, sk_live_) - case-insensitive would just add false positives
    extensions: payload.extensions,
    maxResults,
  });
}

export async function filesystemHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "list":
      return listHandler(task);
    case "read":
      return readHandler(task);
    case "write":
      return writeHandler(task);
    case "delete":
      return deleteHandler(task);
    case "stat":
      return statHandler(task);
    case "search":
      return searchHandler(task);
    case "scan-secrets":
      return scanSecretsHandler(task);
    default:
      throw new Error(
        `Unsupported filesystem operation "${task.operation}". Supported: "list", "read", "write", "delete", "stat", "search", "scan-secrets"`
      );
  }
}
