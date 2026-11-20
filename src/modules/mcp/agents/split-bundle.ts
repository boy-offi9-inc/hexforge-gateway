import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Split-APK handling: XAPK, APKS (Bundletool output) and plain split-APK
 * directories. An XAPK is a ZIP whose payload is one base.apk plus optional
 * split APKs and obb files; an APKS is the same shape from Bundletool. The
 * usual flow is: extract -> analyze the base APK -> (after patching) rebuild
 * by re-zipping the base + splits, so installs keep working.
 *
 * AAB/ABB files need Bundletool and a signing key to turn into installable
 * APKs - out of scope here: `validateProject` flags them, and these helpers
 * handle what can be done with standard ZIP tooling alone.
 *
 * Extraction uses the `unzip` binary when present (streams large payloads)
 * and falls back to nothing - an environment without unzip gets a clear
 * error instead of a half-extracted directory.
 */

export type BundleKind = "xapk" | "apks" | "split-dir";

export function bundleKind(p: string): BundleKind | null {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".xapk") return "xapk";
  if (ext === ".apks") return "apks";
  if (ext === ".aab" || ext === ".abb") return null; // needs bundletool, not zip tooling
  if (existsSync(p) && existsSync(path.join(p, "base.apk"))) return "split-dir";
  return null;
}

/** Extracts an XAPK/APKS (a ZIP) into a directory. Returns the manifest file when present. */
export async function extractBundle(
  bundlePath: string,
  destDir: string,
): Promise<{ files: string[]; manifest?: string }> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("unzip", ["-o", "-q", bundlePath, "-d", destDir], { stdio: "ignore" });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === "ENOENT"
            ? "unzip is not installed - it is needed for XAPK/APKS handling (e.g. `pkg install unzip` on Termux)"
            : err.message,
        ),
      );
    });
    proc.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`unzip exited with code ${code} extracting ${bundlePath}`)),
    );
  });
  const files = (await readdir(destDir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => path.posix.join(e.parentPath ?? "", e.name));
  const manifest = files.find((f) => path.basename(f).toLowerCase() === "manifest.json");
  return { files, manifest };
}

/**
 * Re-zips an extracted bundle directory back into an installable XAPK/APKS.
 * ZIP is a stream format, so `zip -r` on the directory reproduces it - no
 * compression bookkeeping to get wrong.
 */
export async function repackBundle(dir: string, outputPath: string): Promise<void> {
  await rm(outputPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("zip", ["-r", "-q", outputPath, "."], { cwd: dir, stdio: "ignore" });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          err.code === "ENOENT"
            ? "zip is not installed - it is needed for XAPK/APKS handling (e.g. `pkg install zip` on Termux)"
            : err.message,
        ),
      );
    });
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`zip exited with code ${code} packing ${dir}`)),
    );
  });
}
