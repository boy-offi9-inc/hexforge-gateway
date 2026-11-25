import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpTask } from "../../../core/types.js";
import { withSavedOutput } from "./task-output.js";

const execFileAsync = promisify(execFile);

/**
 * Instrumentation-resilience assessment (private roadmap 4C): what does a
 * target look for when it tries to detect Frida, Xposed, root, debuggers
 * and emulators? Composes signals that already exist (APKiD fingerprints
 * for packers/anti-disassembly, exactly like triage) with a scan of the
 * decoded project's smali, Java and native libraries for known detection
 * idioms.
 *
 * The output is an assessment, not a guarantee: "detected" means the
 * indicator string is present, not that the check works or fires; "not
 * observed" means nothing matched, not that the target is unprotected.
 * Every signal cites the file it was seen in so it can back a finding.
 */

export interface ResiliencePayload {
  /** A decoded apktool project directory, a jadx output directory, or an .apk file. */
  target: string;
  /** Forwarded to apkid when a full APK is the target. */
  timeoutSeconds?: number;
}

export interface DetectionSignal {
  category: string;
  /** What the indicator suggests the target is looking for. Assessment language. */
  meaning: string;
  /** Files (workspace-relative where possible) and line numbers, capped. */
  occurrences: { file: string; line?: number }[];
}

export const MAX_OCCURRENCES_PER_CATEGORY = 10;
export const MAX_FILES_SCANNED = 20_000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

interface CategoryDef {
  category: string;
  meaning: string;
  /** Lowercase needles matched case-insensitively. */
  needles: string[];
  /** File types the needle applies to. */
  kinds: ("text" | "binary")[];
}

const CATEGORY_DEFS: CategoryDef[] = [
  {
    category: "frida",
    meaning: "references to Frida itself - the target may try to detect Frida instrumentation",
    needles: ["frida", "gum-js-loop", "gmain", "linjector", "gadget"],
    kinds: ["text", "binary"],
  },
  {
    category: "xposed",
    meaning: "references to Xposed - the target may try to detect Xposed hooks",
    // not the bare word: 'Exposed...' class names contain 'xposed' (verified false positive)
    needles: ["de.robv.android.xposed", "xposedbridge", "xposed.installer", "xposedbridge.jar"],
    kinds: ["text"],
  },
  {
    category: "substrate",
    meaning: "references to Cydia Substrate - the target may try to detect Substrate hooks",
    needles: ["substrate", "cydia"],
    kinds: ["text", "binary"],
  },
  {
    category: "root",
    meaning: "root-detection idioms (su paths, Magisk, SuperSU, root-check libraries)",
    // not the bare '/su': every 'support/...' path contains it (verified false positive)
    needles: ['/su"', "/system/xbin/su", "/system/bin/su", "/sbin/su", "which su", "magisk", "supersu", "superuser", "rootbeer", "busybox"],
    kinds: ["text"],
  },
  {
    category: "debugger",
    meaning: "debugger-detection idioms (isDebuggerConnected, waitForDebugger, ro.debuggable)",
    needles: ["isdebuggerconnected", "waitfordebugger", "ro.debuggable", "ptrace"],
    kinds: ["text", "binary"],
  },
  {
    category: "emulator",
    meaning: "emulator-detection idioms (qemu, goldfish, generic builds, sensor checks)",
    needles: ["qemu", "goldfish", "genymotion", "generic_x86", "ranchu", "emulator"],
    kinds: ["text", "binary"],
  },
  {
    category: "integrity",
    meaning: "signature/integrity-check idioms (GET_SIGNATURES, checksums, re-verification)",
    needles: ["get_signatures", "getsignatures", "packageinfo_signatures", "checksum", "crc32"],
    kinds: ["text"],
  },
];

/** Pure part: does one text buffer produce a hit for a category? Returns the line number. */
export function findTextLine(content: string, needle: string): number | undefined {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx === -1) return undefined;
  let line = 1;
  for (let i = 0; i < idx; i++) if (content[i] === "\n") line++;
  return line;
}

/** Pure part: does one binary buffer contain the needle (ASCII, case-insensitive)? */
export function binaryContains(buf: Buffer, needle: string): boolean {
  return buf.toString("latin1").toLowerCase().includes(needle);
}

/** Walks a project collecting scannable files, split by kind. */
async function listScannable(
  root: string,
): Promise<{ text: string[]; binary: string[] }> {
  const text: string[] = [];
  const binary: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (text.length + binary.length >= MAX_FILES_SCANNED) return;
    const dir = rel === "" ? root : path.join(root, rel);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (text.length + binary.length >= MAX_FILES_SCANNED) return;
      const relPath = rel === "" ? entry.name : path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        await walk(relPath);
      } else if (/\.(smali|java|kt|xml|json|properties|txt|js|html)$/.test(entry.name)) {
        text.push(relPath);
      } else if (entry.name.endsWith(".so")) {
        binary.push(relPath);
      }
    }
  };
  await walk("");
  return { text, binary };
}

/** Pure part: signals from the scan results so far (capped occurrences). */
export function collectSignals(
  hits: Map<string, { file: string; line?: number }[]>,
): DetectionSignal[] {
  const out: DetectionSignal[] = [];
  for (const def of CATEGORY_DEFS) {
    const occ = hits.get(def.category) ?? [];
    if (occ.length === 0) continue;
    out.push({
      category: def.category,
      meaning: def.meaning,
      occurrences: occ.slice(0, MAX_OCCURRENCES_PER_CATEGORY),
    });
  }
  return out;
}

export async function resilienceHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as ResiliencePayload;
  if (!payload.target) throw new Error('resilience requires "target" in the task payload');

  const target = path.resolve(payload.target);
  if (!existsSync(target)) throw new Error(`Target not found at path: ${target}`);
  const st = await stat(target);
  const isApk = st.isFile() && target.toLowerCase().endsWith(".apk");
  const isDir = st.isDirectory();
  if (!isApk && !isDir) throw new Error('"target" must be an .apk file or a directory (decoded/decompiled project)');

  const warnings: string[] = [];
  const hits = new Map<string, { file: string; line?: number }[]>();

  let apkid: unknown = null;
  if (isApk) {
    const timeout = payload.timeoutSeconds ?? 30;
    try {
      const { stdout } = await execFileAsync("apkid", ["-j", "-t", String(timeout), target], {
        maxBuffer: 1024 * 1024 * 10,
      });
      try {
        apkid = JSON.parse(stdout);
      } catch {
        apkid = { raw: stdout };
      }
    } catch {
      warnings.push(
        "apkid not available or failed - packer/anti-disassembly fingerprints are absent from this assessment. Install: pip install apkid",
      );
    }
  }

  if (isDir) {
    const { text, binary } = await listScannable(target);
    for (const rel of text) {
      const stat_ = await stat(path.join(target, rel)).catch(() => null);
      if (!stat_ || stat_.size > MAX_FILE_BYTES) continue;
      const content = await readFile(path.join(target, rel), "utf8").catch(() => null);
      if (content === null) continue;
      const lower = content.toLowerCase();
      for (const def of CATEGORY_DEFS) {
        if (!def.kinds.includes("text")) continue;
        for (const needle of def.needles) {
          if (!lower.includes(needle)) continue;
          const line = findTextLine(content, needle);
          const arr = hits.get(def.category) ?? [];
          // one occurrence per file per category - the file list is the signal
          if (!arr.some((o) => o.file === rel)) arr.push({ file: rel, line });
          hits.set(def.category, arr);
          break;
        }
      }
    }
    for (const rel of binary) {
      const stat_ = await stat(path.join(target, rel)).catch(() => null);
      if (!stat_ || stat_.size > MAX_FILE_BYTES) continue;
      const buf = await readFile(path.join(target, rel)).catch(() => null);
      if (buf === null) continue;
      for (const def of CATEGORY_DEFS) {
        if (!def.kinds.includes("binary")) continue;
        for (const needle of def.needles) {
          if (!binaryContains(buf, needle)) continue;
          const arr = hits.get(def.category) ?? [];
          if (!arr.some((o) => o.file === rel)) arr.push({ file: rel });
          hits.set(def.category, arr);
          break;
        }
      }
    }
  } else {
    warnings.push(
      "Detection-idiom scanning needs a decoded project (apktool decode or jadx output) - run this agent on the decode output; an APK only yields APKiD fingerprints.",
    );
  }

  const signals = collectSignals(hits);
  const result = {
    target,
    kind: isApk ? "apk" : "project",
    fingerprints: apkid,
    signals,
    summary: {
      categoriesDetected: signals.map((s) => s.category),
      categoriesNotObserved: CATEGORY_DEFS.map((d) => d.category).filter(
        (c) => !signals.some((s) => s.category === c),
      ),
    },
    disclaimer:
      "Assessment, not a guarantee: 'detected' means the indicator was observed in the artifact; 'not observed' means nothing matched, not that the target is unprotected. Detection logic is often obfuscated, string-encrypted or native-only.",
    warnings: warnings.length > 0 ? warnings : undefined,
  };
  return withSavedOutput(task, "resilience", result);
}
