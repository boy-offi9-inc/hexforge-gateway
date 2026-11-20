import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";

const execFileAsync = promisify(execFile);

/**
 * Ghidra agent - headless native analysis via `analyzeHeadless`.
 *
 * Ghidra ships no CLI for per-function queries; its headless mode runs a
 * project import plus optional post-scripts. This agent writes a plain-Java
 * post-script (Ghidra 12 dropped Jython; .java scripts compile on the fly)
 * that walks every function in the imported program and emits JSON
 * (decompiled C, xrefs, call targets), then reads that file back as the result. Everything else - project lifecycle,
 * analysis, artifact recording - is the Gateway's, same as every other
 * agent.
 *
 * The binary is located via GHIDRA_HOME (the extracted release directory,
 * e.g. /opt/ghidra_12.2_PUBLIC), or `ghidra` on PATH. Pinned in
 * Dockerfile.runtime; see scripts/check-runtime.mjs.
 */

const ANALYZABLE_EXTENSIONS = [".so", ".elf", ".bin", ".dex", ".apk"];
const MAX_DECOMPILE_CHARS = 8000; // per function, keeps a big .so report bounded
const MAX_FUNCTIONS = 2000; // report cap; ordering is by address

interface GhidraPayload {
  filePath: string;
  /** Optional Ghidra install dir; defaults to GHIDRA_HOME or `ghidra` on PATH. */
  ghidraHome?: string;
}

function assertValidPayload(payload: Record<string, unknown>): GhidraPayload {
  const filePath = payload.filePath;
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new Error('ghidra agent requires a "filePath" string in the task payload');
  }
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found at path: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ANALYZABLE_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file type "${ext}". Expected one of: ${ANALYZABLE_EXTENSIONS.join(", ")}`,
    );
  }
  const ghidraHome =
    typeof payload.ghidraHome === "string" && payload.ghidraHome.trim().length > 0
      ? path.resolve(payload.ghidraHome)
      : undefined;
  if (
    ghidraHome !== undefined &&
    !existsSync(path.join(ghidraHome, "support", "analyzeHeadless"))
  ) {
    throw new Error(
      `ghidraHome "${ghidraHome}" does not look like a Ghidra install (no support/analyzeHeadless)`,
    );
  }
  return { filePath: resolved, ghidraHome };
}

/** Resolve the analyzeHeadless launcher. */
function resolveAnalyzeHeadless(ghidraHome?: string): { file: string; args: string[] } {
  if (ghidraHome) {
    return { file: path.join(ghidraHome, "support", "analyzeHeadless"), args: [] };
  }
  const envHome = process.env.GHIDRA_HOME;
  if (envHome && existsSync(path.join(envHome, "support", "analyzeHeadless"))) {
    return { file: path.join(envHome, "support", "analyzeHeadless"), args: [] };
  }
  // Fall back to PATH (some distros wrap it).
  return { file: "analyzeHeadless", args: [] };
}

/**
 * Post-script: scripts/ghidra/hexforge_dump.java - a plain-Java GhidraScript
 * (Ghidra 12 dropped Jython; .java scripts compile on the fly) that decompiles
 * every function and writes one JSON document. It reads GHIDRA_REPORT,
 * GHIDRA_MAX_DECOMPILE and GHIDRA_MAX_FUNCTIONS from the environment. Shipped
 * as a real file rather than an inline template so its escapes stay honest
 * and it can be edited/tested on its own.
 */
function postScriptPath(): string {
  // dist/modules/mcp/agents -> repo root is 5 levels up in dist, 3 in src
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "../../../../scripts/ghidra/hexforge_dump.java"), // dist layout
    path.resolve(here, "../../../scripts/ghidra/hexforge_dump.java"), // src layout
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return path.dirname(candidate);
  }
  throw new Error(
    "hexforge_dump.java post-script not found next to the ghidra agent - reinstall the Gateway",
  );
}

/** Ghidra headless prints a lot; keep the interesting tail for error reports. */
function tail(text: string, n = 2000): string | undefined {
  return text ? text.slice(-n) : undefined;
}

export async function ghidraHandler(task: McpTask): Promise<unknown> {
  if (task.operation !== "analyze") {
    throw new Error(`Unsupported ghidra operation "${task.operation}". Supported: "analyze"`);
  }

  const { filePath, ghidraHome } = assertValidPayload(task.payload);

  const analyzeHeadless = resolveAnalyzeHeadless(ghidraHome);
  const workspaceDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "ghidra");
  await mkdir(workspaceDir, { recursive: true });

  // Ephemeral headless project: imported once, analyzed, read, kept as the
  // artifact (re-analysis reuses it via -process instead of -import later).
  const projectName = "hexforge-" + path.basename(filePath).replace(/[^A-Za-z0-9._-]/g, "_");
  const reportPath = path.join(workspaceDir, projectName + ".analysis.json");
  const scriptDir = postScriptPath();

  const args = [
    ...analyzeHeadless.args,
    workspaceDir, // Ghidra treats the first positional as the project location
    projectName,
    "-import",
    filePath,
    "-scriptPath",
    scriptDir,
    "-postScript",
    "hexforge_dump.java",
    "-deleteProject", // analysis state isn't the artifact; the JSON report is
  ];

  const env = {
    ...process.env,
    GHIDRA_REPORT: reportPath,
    GHIDRA_MAX_DECOMPILE: String(MAX_DECOMPILE_CHARS),
    GHIDRA_MAX_FUNCTIONS: String(MAX_FUNCTIONS),
  };

  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(analyzeHeadless.file, args, {
      env,
      maxBuffer: 64 * 1024 * 1024, // headless analysis is chatty
      timeout: 30 * 60 * 1000, // big .so files can take a while on one core
    }));
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string; killed?: boolean };
    const combined = (e.stdout || "") + (e.stderr || "");
    // A missing binary never reaches the report; an analysis error inside
    // Ghidra usually still prints "ERROR" but may have written one. Only
    // hard-fail when no binary ran or the run was killed.
    if (!existsSync(reportPath) && (killedByTimeout(e) || !combined.includes("analyzeHeadless"))) {
      throw friendlyExecError(
        "ghidra",
        "Install Ghidra and point GHIDRA_HOME at the extracted release directory (e.g. /opt/ghidra_12.2_PUBLIC), or put analyzeHeadless on PATH - https://ghidra-sre.org/",
        e,
      );
    }
    stdout = e.stdout || "";
    stderr = e.stderr || "";
  }

  if (!existsSync(reportPath)) {
    throw new Error(
      "ghidra analysis finished but produced no report - see stderrTail for the headless output",
    );
  }

  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    program: string;
    language: string;
    functionCount: number;
    reported: number;
    functions: Array<{ name: string; address: string; decompiled?: string }>;
  };

  return {
    reportPath,
    outputPath: reportPath,
    program: report.program,
    language: report.language,
    functionCount: report.functionCount,
    reportedFunctions: report.reported,
    truncated: report.functionCount > report.reported,
    functions: report.functions.slice(0, 50), // response preview; full report is the artifact file
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
}

function killedByTimeout(err: Error & { killed?: boolean }): boolean {
  return err.killed === true || /timed out|ETIMEDOUT/i.test(err.message || "");
}
