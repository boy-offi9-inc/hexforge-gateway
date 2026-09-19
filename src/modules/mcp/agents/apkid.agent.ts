import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { friendlyExecError } from "./shared/exec-error.js";

const execFileAsync = promisify(execFile);

/**
 * Wraps APKiD (https://github.com/rednaga/APKiD) - a real, actively
 * maintained YARA-rules-based tool that fingerprints compilers, packers,
 * obfuscators, and anti-debug/anti-VM tricks in an APK/DEX. Installed via
 * `pip install apkid` (needs a yara-python build with DEX support - see
 * APKiD's own install docs, it's not a plain `pip install yara-python`).
 *
 * Deliberately a thin wrapper, same as jadx/apktool/adb: this doesn't
 * reimplement packer detection with a weaker heuristic - APKiD's YARA
 * rules are the real thing, maintained by people who actually track new
 * packers. Output is passed through as APKiD's own JSON, not reshaped
 * into a HexForge-specific schema, since that schema is APKiD's to
 * define and evolve, not something worth guessing at and duplicating here.
 */

interface IdentifyPayload {
  apkPath: string;
  timeoutSeconds?: number; // per-file YARA scan timeout, forwarded to apkid's own -t flag
}

const DEFAULT_TIMEOUT_SECONDS = 30;

async function identifyHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as IdentifyPayload;
  if (!payload.apkPath) throw new Error('identify requires "apkPath" in the task payload');

  const apkPath = path.resolve(payload.apkPath);
  if (!existsSync(apkPath)) throw new Error(`File not found at path: ${apkPath}`);

  const timeoutSeconds = payload.timeoutSeconds && payload.timeoutSeconds > 0 ? payload.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("apkid", ["-j", "-t", String(timeoutSeconds), apkPath], {
      maxBuffer: 1024 * 1024 * 10,
    }));
  } catch (err) {
    throw friendlyExecError(
      "apkid",
      'Install it with "pip install apkid" - note it needs a yara-python build with DEX support first, plain ' +
        "yara-python isn't enough. See https://github.com/rednaga/APKiD#installation.",
      err
    );
  }

  try {
    return JSON.parse(stdout);
  } catch {
    // Older APKiD versions or unexpected output - return the raw text
    // rather than throwing, since the scan itself succeeded.
    return { raw: stdout };
  }
}

export async function apkidHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "identify":
      return identifyHandler(task);
    default:
      throw new Error(`Unsupported apkid operation "${task.operation}". Supported: "identify"`);
  }
}
