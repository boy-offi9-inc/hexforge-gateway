import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpTask } from "../../../core/types.js";
import { withSavedOutput } from "./task-output.js";

const execFileAsync = promisify(execFile);

/**
 * Triage front door: fingerprint-first assessment of an APK or an already
 * decoded/decompiled project, before anyone pays for a full decompile.
 * Composes signals that already exist rather than reimplementing them:
 * APKiD's YARA fingerprints (packer/compiler/obfuscator), the manifest
 * (package, minSdk/targetSdk, permissions, exported components, application
 * class), the native library inventory (.so files per ABI) and, the native library inventory (.so files per ABI) and
 * Kotlin metadata recovery for obfuscated classes.
 *
 * The output is a triage report, not a verdict: marker absence doesn't
 * prove a target is clean, so confidence language ("detected", "not
 * observed") is used throughout rather than "safe"/"protected".
 */

interface TriagePayload {
  /** An APK file, or a decoded apktool project directory, or a jadx output directory. */
  target: string;
  /** Forwarded to apkid when a full APK is the target. */
  timeoutSeconds?: number;
}

const KNOWN_ABIS = new Set(["arm64-v8a", "armeabi-v7a", "x86", "x86_64", "mips", "mips64"]);

interface ManifestInfo {
  packageName?: string;
  versionName?: string;
  versionCode?: string;
  minSdk?: string;
  targetSdk?: string;
  compileSdk?: string;
  permissions: string[];
  exportedComponents: { type: string; name: string }[];
  applicationClass?: string;
}

function attrValue(manifest: string, attr: string): string | undefined {
  const m =
    manifest.match(new RegExp(`android:${attr}="([^"]+)"`)) ??
    manifest.match(new RegExp(`${attr}="([^"]+)"`));
  return m?.[1];
}

export function parseManifest(manifest: string): ManifestInfo {
  const permissions = [...manifest.matchAll(/android:name="([^"]+\.permission\.[^"]+|android\.permission\.[^"]+)"/g)]
    .map((m) => m[1]);
  const usesPermissions = [...manifest.matchAll(/<uses-permission[^>]*android:name="([^"]+)"/g)]
    .map((m) => m[1]);
  const exported: ManifestInfo["exportedComponents"] = [];
  for (const comp of ["activity", "service", "receiver", "provider"]) {
    const re = new RegExp(`<${comp}[^>]*android:name="([^"]+)"[^>]*>`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(manifest)) !== null) {
      const tag = m[0];
      if (/android:exported="true"/.test(tag) || (m[1].includes(".") && !/android:exported/.test(tag))) {
        exported.push({ type: comp, name: m[1] });
      }
    }
  }
  return {
    packageName: attrValue(manifest, "package"),
    versionName: attrValue(manifest, "versionName"),
    versionCode: attrValue(manifest, "versionCode"),
    minSdk: attrValue(manifest, "minSdkVersion"),
    targetSdk: attrValue(manifest, "targetSdkVersion"),
    compileSdk: attrValue(manifest, "compileSdkVersion"),
    permissions: [...new Set([...permissions, ...usesPermissions])],
    exportedComponents: exported,
    applicationClass: attrValue(manifest, "applicationName") ??
      manifest.match(/<application[^>]*android:name="([^"]+)"/)?.[1],
  };
}

/**
 * Kotlin name recovery: R8/ProGuard-renamed classes lose their Java names,
 * but @Metadata annotations keep the original names as base64-encoded
 * proto. Any class still carrying kotlin/Metadata that names an original
 * class is recoverable without executing anything.
 */
export async function recoverKotlinNames(
  sourcesRoot: string,
  limit = 100,
): Promise<{ count: number; samples: { renamed: string; original: string }[]; truncated: boolean }> {
  const samples: { renamed: string; original: string }[] = [];
  let count = 0;
  let truncated = false;
  const kotlinMeta = /Lkotlin\/Metadata;/;
  const d2 = /d2:([^"\\]{4,})/;

  async function walk(dir: string, depth: number): Promise<void> {
    if (truncated || depth > 12) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (truncated) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith(".java") && !entry.name.endsWith(".smali")) continue;
      let text: string;
      try {
        text = await readFile(full, "utf8");
      } catch {
        continue;
      }
      if (!text.includes("kotlin/metadata") && !text.includes("kotlin.Metadata") && !text.includes("Lkotlin/Metadata")) continue;
      const rel = path.relative(sourcesRoot, full);
      const m = text.match(d2);
      if (m?.[1]) {
        count++;
        if (samples.length < limit) {
          samples.push({ renamed: rel, original: m[1] });
        } else {
          truncated = true;
        }
      }
    }
  }

  await walk(sourcesRoot, 0);
  return { count, samples, truncated };
}

interface NativeLib {
  abi: string;
  libraries: string[];
}

async function nativeInventory(target: string): Promise<NativeLib[]> {
  const libsDir = path.join(target, "lib");
  if (!existsSync(libsDir)) return [];
  const out: NativeLib[] = [];
  for (const abi of await readdir(libsDir, { withFileTypes: true })) {
    if (!abi.isDirectory()) continue;
    const isAbi = KNOWN_ABIS.has(abi.name) || abi.name.startsWith("arm") || abi.name.startsWith("x86");
    if (!isAbi) continue;
    const libs = (await readdir(path.join(libsDir, abi.name)))
      .filter((f) => f.endsWith(".so"))
      .map((f) => f.replace(/^lib/, "").replace(/\.so$/, ""));
    out.push({ abi: abi.name, libraries: libs });
  }
  return out;
}

function apktoolManifestPath(target: string): string | undefined {
  const p = path.join(target, "AndroidManifest.xml");
  return existsSync(p) ? p : undefined;
}

export async function triageHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as TriagePayload;
  if (!payload.target) throw new Error('triage requires "target" in the task payload');

  const target = path.resolve(payload.target);
  if (!existsSync(target)) throw new Error(`Target not found at path: ${target}`);

  const st = await stat(target);
  const isApk = st.isFile() && target.toLowerCase().endsWith(".apk");
  const isDir = st.isDirectory();
  if (!isApk && !isDir) throw new Error('"target" must be an .apk file or a directory (decoded/decompiled project)');

  const warnings: string[] = [];

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
    } catch (err) {
      warnings.push(
        "apkid not available or failed - packer/compiler fingerprints are absent from this report. " +
          "Install: pip install apkid",
      );
    }
  }

  let manifest: ManifestInfo | undefined;
  const manifestPath = apktoolManifestPath(target);
  if (manifestPath) {
    try {
      manifest = parseManifest(await readFile(manifestPath, "utf8"));
    } catch {
      warnings.push("AndroidManifest.xml exists but could not be parsed.");
    }
  } else if (!isApk) {
    warnings.push("No AndroidManifest.xml at the target root - pass an apktool decode output for manifest analysis.");
  }

  const nativeLibs = isDir ? await nativeInventory(target) : [];
  if (isApk) warnings.push("Native library inventory needs a decoded project (apktool decode) - run it on the decode output.");

  const jadxSources = isDir ? path.join(target, "sources") : target;
  let kotlin: Awaited<ReturnType<typeof recoverKotlinNames>> | null = null;
  if (isDir && existsSync(jadxSources)) {
    kotlin = await recoverKotlinNames(jadxSources);
  }

  const obfuscationHints = {
    apkid: apkid,
    shortSmaliNames: isDir ? undefined : "decode the project for smali-level obfuscation checks",
  };

  const result = {
    target,
    kind: isApk ? "apk" : "project",
    manifest,
    fingerprints: apkid,
    nativeLibs: nativeLibs.length > 0 ? nativeLibs : undefined,
    kotlinNames: kotlin ?? undefined,
    obfuscationHints,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
  return withSavedOutput(task, "triage", result);
}
