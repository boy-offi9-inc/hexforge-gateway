import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";

const execFileAsync = promisify(execFile);

const SIGNER_HINT =
  "On Termux: pkg install apksigner aapt openjdk-17. Elsewhere, install the Android SDK build-tools (apksigner, zipalign) and a JDK (keytool).";

// A throwaway debug key, generated on first use. The signature it makes differs from
// the original app's, so a signed copy can't update the original - and isn't for release.
const KEY_ALIAS = "hexforge-debug";
const KEY_PASS = "android";

/**
 * "sdk": the Android SDK's apksigner (`apksigner sign --ks ...`), with zipalign and
 * keytool alongside. "lite": the small apksigner that Termux's package installs
 * (`apksigner [-p password] keystore input output`), which also aligns.
 */
export type SignerFlavor = "sdk" | "lite";

interface SignPayload {
  apkPath?: string; // the APK to sign
  outputPath?: string; // a workflow can leave apkPath out and use the previous step's outputPath
  outputName?: string; // file name written under WORKSPACES_ROOT/<workspaceId>/apksigner/signed/
  flavor?: SignerFlavor; // override the detected apksigner type
}

let detectedFlavor: SignerFlavor | undefined;

/** Forgets the detected apksigner type. Only tests need this. */
export function clearSignerCache(): void {
  detectedFlavor = undefined;
}

/**
 * The SDK's apksigner answers `--version` and exits 0; the lite one doesn't
 * (it treats that as a bad command line). That is the tell, remembered for the
 * process. If it guesses wrong, the caller can pass `flavor` explicitly.
 */
async function signerFlavor(requested?: SignerFlavor): Promise<SignerFlavor> {
  if (requested === "sdk" || requested === "lite") return requested;
  if (detectedFlavor) return detectedFlavor;
  try {
    await execFileAsync("apksigner", ["--version"], { timeout: 15_000 });
    detectedFlavor = "sdk";
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      throw friendlyExecError("apksigner", SIGNER_HINT, err);
    }
    detectedFlavor = "lite";
  }
  return detectedFlavor;
}

async function run(binary: string, args: string[], timeout = 120_000) {
  try {
    return await execFileAsync(binary, args, { maxBuffer: 1024 * 1024 * 20, timeout });
  } catch (err) {
    throw friendlyExecError(binary, SIGNER_HINT, err);
  }
}

async function ensureKeystore(): Promise<string> {
  const keystore = path.resolve(config.DATA_DIR, "signing", "debug.keystore");
  if (existsSync(keystore)) return keystore;
  await mkdir(path.dirname(keystore), { recursive: true });
  await run("keytool", [
    "-genkeypair",
    "-keystore",
    keystore,
    "-alias",
    KEY_ALIAS,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-storepass",
    KEY_PASS,
    "-keypass",
    KEY_PASS,
    "-dname",
    "CN=HexForge Debug, O=HexForge, C=US",
  ]);
  return keystore;
}

/** Which signature schemes `apksigner verify --verbose` reported as verified. */
function verifiedSchemes(output: string): string[] {
  const schemes: string[] = [];
  for (const m of output.matchAll(/Verified using (v\d(?:\.\d)?) scheme[^:\n]*:\s*true/gi)) {
    if (m[1]) schemes.push(m[1].toLowerCase());
  }
  return schemes;
}

async function signSdk(input: string, output: string, taskId: string) {
  const warnings: string[] = [];
  const keystore = await ensureKeystore();

  // Align first: apksigner's v2+ signature covers the whole file, so aligning afterwards breaks it.
  let toSign = input;
  let aligned = false;
  const alignedPath = path.join(path.dirname(output), `.aligned-${taskId}.apk`);
  try {
    await execFileAsync("zipalign", ["-f", "-p", "4", input, alignedPath], { timeout: 120_000 });
    toSign = alignedPath;
    aligned = true;
  } catch (err) {
    if ((err as { code?: string })?.code !== "ENOENT") {
      throw friendlyExecError("zipalign", SIGNER_HINT, err);
    }
    warnings.push(
      "zipalign was not found, so the APK was signed without being aligned; an app targeting Android 11 or newer may refuse to install it.",
    );
  }

  try {
    await run("apksigner", [
      "sign",
      "--ks",
      keystore,
      "--ks-key-alias",
      KEY_ALIAS,
      "--ks-pass",
      `pass:${KEY_PASS}`,
      "--key-pass",
      `pass:${KEY_PASS}`,
      "--out",
      output,
      toSign,
    ]);
  } finally {
    await rm(alignedPath, { force: true });
  }

  // An APK that doesn't verify is worse than none: remove it rather than leave it to be installed.
  let verified: string;
  try {
    verified = (await run("apksigner", ["verify", "--verbose", output])).stdout;
  } catch (err) {
    await rm(output, { force: true });
    throw err;
  }
  return { aligned, schemes: verifiedSchemes(verified), warnings };
}

async function signLite(input: string, output: string) {
  const keystore = path.resolve(config.DATA_DIR, "signing", "debug.keystore");
  await mkdir(path.dirname(keystore), { recursive: true });
  // The lite apksigner creates the keystore if it isn't there, and aligns as it signs.
  await run("apksigner", ["-p", KEY_PASS, keystore, input, output]);
  return {
    warnings: [
      "Signed with Termux's lightweight apksigner, which doesn't report which signature schemes it wrote. If the install fails with a signature error, sign with the Android SDK's apksigner instead.",
    ],
  };
}

export async function apksignerHandler(task: McpTask): Promise<unknown> {
  if (task.operation !== "sign") {
    throw new Error(`Unsupported apksigner operation "${task.operation}". Supported: "sign"`);
  }
  const payload = task.payload as unknown as SignPayload;
  const apkArg = payload.apkPath ?? payload.outputPath;
  if (!apkArg) throw new Error('sign requires "apkPath" in the task payload');

  const input = path.resolve(apkArg);
  if (!existsSync(input)) throw new Error(`File not found at path: ${input}`);
  if (path.extname(input).toLowerCase() !== ".apk") {
    throw new Error(`Expected an .apk file, got "${path.extname(input) || "no extension"}"`);
  }

  const outputName =
    payload.outputName?.trim() || `${path.basename(input, path.extname(input))}-signed.apk`;
  if (outputName.includes("/") || outputName.includes("\\") || outputName.includes("..")) {
    throw new Error('"outputName" must be a plain file name, not a path');
  }
  const outDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "apksigner", "signed");
  await mkdir(outDir, { recursive: true });
  const output = path.join(outDir, outputName);
  if (output === input) throw new Error("The signed APK can't overwrite the APK being signed");
  await rm(output, { force: true });

  const flavor = await signerFlavor(payload.flavor);
  const details =
    flavor === "sdk" ? await signSdk(input, output, task.id) : await signLite(input, output);

  return {
    outputPath: output,
    // Same file again under the key the adb "install" operation reads, so a workflow
    // step after this one can install it without being told the path.
    apkPath: output,
    signed: true,
    flavor,
    ...details,
    warnings: details.warnings.length > 0 ? details.warnings : undefined,
  };
}

