import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolProvenance } from "./types.js";

const execFileAsync = promisify(execFile);

/** Runs a command and returns what it printed. Injected in tests. */
export type Runner = (file: string, args: string[]) => Promise<string>;

/**
 * How to ask each known backend for its version. The names match the
 * `backends` declared in the built-in descriptors; a backend with no entry
 * here (frida-server runs on the device, apk-mcp is remote) is simply left
 * without a version rather than guessed.
 *
 * `frida --version` reports the Frida core version, so that backend is
 * named "frida", not "frida-tools" (the CLI package versions separately).
 */
const PROBES: Record<string, { file: string; args: string[] }> = {
  jadx: { file: "jadx", args: ["--version"] },
  apktool: { file: "apktool", args: ["--version"] },
  apkid: { file: "apkid", args: ["--version"] },
  adb: { file: "adb", args: ["version"] },
  frida: { file: "frida", args: ["--version"] },
};

const defaultRunner: Runner = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  return stdout.trim() || stderr;
};

/** First non-empty line, whitespace collapsed, capped so odd output can't bloat a record. */
function firstLine(output: string): string | undefined {
  const line = output
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  return line?.slice(0, 100);
}

/**
 * Builds a resolver that fills in backend versions. Each tool is probed at
 * most once per resolver once it succeeds; a failed probe (not installed,
 * timed out, no output) is not cached, so installing a tool later takes
 * effect without restarting, and it never throws - provenance is
 * best-effort and must not break whatever is recording it.
 */
export function createToolVersionResolver(run: Runner = defaultRunner) {
  const known = new Map<string, string>();

  async function versionOf(tool: string): Promise<string | undefined> {
    const cached = known.get(tool);
    if (cached) return cached;
    const probe = PROBES[tool];
    if (!probe) return undefined;
    try {
      const version = firstLine(await run(probe.file, probe.args));
      if (version) known.set(tool, version);
      return version;
    } catch {
      return undefined;
    }
  }

  return async function resolveToolVersions(
    backends?: ToolProvenance[],
  ): Promise<ToolProvenance[] | undefined> {
    if (!backends?.length) return undefined;
    return Promise.all(
      backends.map(async (b) => {
        const version = b.version ?? (await versionOf(b.tool));
        return version ? { ...b, version } : { ...b };
      }),
    );
  };
}

export const resolveToolVersions = createToolVersionResolver();
