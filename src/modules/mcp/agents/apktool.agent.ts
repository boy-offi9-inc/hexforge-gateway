import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateProject } from "./android-validate.js";
import { bundleKind, extractBundle } from "./split-bundle.js";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";
import { friendlyExecError } from "./shared/exec-error.js";
import { applyTextPatch, MAX_PATCH_FILE_BYTES } from "./apk-patch.js";
import { withSavedOutput } from "./task-output.js";

const execFileAsync = promisify(execFile);

const ALLOWED_EXTENSIONS = [".apk", ".jar", ".zip"];

/**
 * Patch lineage file: every "patch" operation appends what it changed, so a
 * rebuilt APK can say exactly which edits produced it. Lives inside the
 * project (and is ignored by apktool - it is not under res/ or smali/).
 */
const LINEAGE_FILE = ".hexforge-patches.json";

interface PatchLineageEntry {
  /** The task that made the edit. */
  taskId: string;
  patchedFile: string;
  replacements: number;
  sha256After: string;
  at: string;
}

/** Reads the project's patch lineage; an unpatched project has none. */
async function readLineage(projectDir: string): Promise<PatchLineageEntry[]> {
  try {
    const raw = await readFile(path.join(projectDir, LINEAGE_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PatchLineageEntry[]) : [];
  } catch {
    return [];
  }
}

/** Appends one patch record to the project's lineage file. */
async function appendLineage(projectDir: string, entry: PatchLineageEntry): Promise<void> {
  const all = await readLineage(projectDir);
  all.push(entry);
  await writeFile(path.join(projectDir, LINEAGE_FILE), JSON.stringify(all, null, 2), "utf8");
}

interface DecodePayload {
  apkPath: string;
  noSrc?: boolean; // skip smali disassembly (resources only, faster)
  noRes?: boolean; // skip resource decoding (smali only)
  force?: boolean; // overwrite existing output dir
}

interface BuildPayload {
  // The decoded project directory. A workflow can leave this out: with
  // mergePreviousResult, a preceding "decode" supplies `outputDir` and a
  // preceding "patch" supplies `projectDir`.
  inputDir?: string;
  projectDir?: string;
  outputDir?: string;
  outputName?: string; // file name written under WORKSPACES_ROOT/<workspaceId>/apktool/build/
}

interface PatchPayload {
  projectDir?: string; // decoded project directory (`inputDir` / `outputDir` also accepted)
  inputDir?: string;
  outputDir?: string;
  file?: string; // path inside the project, e.g. "smali/com/acme/Login.smali"
  find?: string; // exact text to replace
  replace?: string;
  all?: boolean; // replace every match instead of requiring exactly one
}

interface GadgetPayload {
  projectDir?: string; // decoded project directory (`inputDir` / `outputDir` also accepted)
  inputDir?: string;
  outputDir?: string;
  /** Local path to the frida-gadget .so for the target ABI. */
  gadgetPath?: string;
  /** ABI directory the gadget goes into (default arm64-v8a). */
  abi?: string;
  /** Class whose onCreate loads the gadget (default: the manifest's application class). */
  entryClass?: string;
  /** Frida script the gadget should load (writes the gadget config file). */
  scriptPath?: string;
}

function resolveExistingApk(apkPath: string): string {
  const resolved = path.resolve(apkPath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found at path: ${resolved}`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw new Error(
      `Unsupported file type "${ext}". Expected one of: ${ALLOWED_EXTENSIONS.join(", ")}`,
    );
  }
  return resolved;
}

async function listFilesCapped(dir: string, limit = 200): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string) {
    if (results.length >= limit) return;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        results.push(path.relative(dir, full));
      }
    }
  }

  await walk(dir);
  return results;
}

async function decodeHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as DecodePayload;
  if (!payload.apkPath) {
    throw new Error('decode requires "apkPath" in the task payload');
  }
  let apkPath = resolveExistingApk(payload.apkPath);

  // XAPK/APKS bundles: extract first, then decode the base APK. The other
  // splits stay next to it in the bundle directory (repacked later by
  // apksigner's sign, or the repackBundle helper).
  let bundle: { dir: string; kind: string; files: number } | undefined;
  const kind = bundleKind(apkPath);
  if (kind === "xapk" || kind === "apks") {
    const bundleDir = path.resolve(
      config.WORKSPACES_ROOT,
      task.workspaceId,
      "apktool",
      "bundles",
      path.basename(apkPath, path.extname(apkPath)),
    );
    const { files } = await extractBundle(apkPath, bundleDir);
    const base = path.join(bundleDir, "base.apk");
    if (!existsSync(base)) {
      throw new Error(
        `"${path.basename(apkPath)}" extracted to ${files.length} file(s) but has no base.apk - not an installable Android bundle`,
      );
    }
    apkPath = base;
    bundle = { dir: bundleDir, kind, files: files.length };
  }

  const outputDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "apktool", "decode");
  await mkdir(path.dirname(outputDir), { recursive: true });

  const args = ["d", apkPath, "-o", outputDir, "-f"]; // -f: always overwrite, workspace-scoped dir is ours to manage
  if (payload.noSrc) args.push("-s");
  if (payload.noRes) args.push("-r");

  try {
    const { stdout, stderr } = await execFileAsync("apktool", args, {
      maxBuffer: 1024 * 1024 * 20,
    });

    const files = await listFilesCapped(outputDir);

    return {
      outputDir,
      fileCount: files.length,
      files,
      bundle,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr ? stderr.slice(-2000) : undefined,
    };
  } catch (err) {
    throw friendlyExecError(
      "apktool",
      "Install it first (e.g. via your package manager, or see https://apktool.org/docs/install).",
      err,
    );
  }
}

/** Pre-flight validation of a decoded project - report language, all issues at once. */
async function validateHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as BuildPayload;
  const projectDir = payload.inputDir ?? payload.projectDir ?? payload.outputDir;
  if (!projectDir) {
    throw new Error(
      'validate requires "inputDir" (a decoded apktool project directory) in the task payload',
    );
  }
  const inputDir = path.resolve(projectDir);
  const result = await validateProject(inputDir);
  return {
    ok: result.ok,
    issues: result.issues,
    checked: result.checked,
    projectDir: inputDir,
    // next step when ok: the "build" operation on this same projectDir
    next: result.ok ? "build" : undefined,
  };
}

async function buildHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as BuildPayload;
  const projectDir = payload.inputDir ?? payload.projectDir ?? payload.outputDir;
  if (!projectDir) {
    throw new Error(
      'build requires "inputDir" (a decoded apktool project directory) in the task payload',
    );
  }

  const inputDir = path.resolve(projectDir);
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
    throw new Error(`Directory not found at path: ${inputDir}`);
  }
  // apktool.yml is the marker file every decoded project has; catches
  // pointing this at a random folder before wasting time on a doomed build.
  if (!existsSync(path.join(inputDir, "apktool.yml"))) {
    throw new Error(
      `"${inputDir}" doesn't look like an apktool project (no apktool.yml found). Did you mean the output of a prior "decode" operation?`,
    );
  }

  // pre-flight: catch doomed builds in seconds instead of a mid-build failure
  const validation = await validateProject(inputDir);
  if (!validation.ok) {
    throw new Error(
      `build pre-flight found ${validation.issues.length} problem(s): ` +
        validation.issues.map((i) => `${i.file ?? "project"}: ${i.problem}`).join("; ") +
        ` - run the "validate" operation for the full report`,
    );
  }

  const buildDir = path.resolve(config.WORKSPACES_ROOT, task.workspaceId, "apktool", "build");
  await mkdir(buildDir, { recursive: true });

  const outputName = payload.outputName?.trim() || "rebuilt.apk";
  if (outputName.includes("/") || outputName.includes("\\") || outputName.includes("..")) {
    throw new Error('"outputName" must be a plain file name, not a path');
  }
  const outputPath = path.join(buildDir, outputName);

  try {
    const { stdout, stderr } = await execFileAsync("apktool", ["b", inputDir, "-o", outputPath], {
      maxBuffer: 1024 * 1024 * 20,
    });

    // Traceability: the rebuilt APK reports every patch that went into it.
    const lineage = await readLineage(inputDir);
    const apkBytes = await readFile(outputPath);

    return {
      outputPath,
      sha256: sha256(apkBytes),
      // Rebuilt APKs from apktool are NOT signed - a real device/emulator
      // install needs signing first: the apksigner agent's "sign" operation
      // takes this outputPath as its input.
      signed: false,
      patches: lineage.length > 0 ? lineage : undefined,
      patchCount: lineage.length,
      stdoutTail: stdout.slice(-2000),
      stderrTail: stderr ? stderr.slice(-2000) : undefined,
    };
  } catch (err) {
    throw friendlyExecError(
      "apktool",
      "Install it first (e.g. via your package manager, or see https://apktool.org/docs/install).",
      err,
    );
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Edits one text file inside a decoded project by replacing exact text, and
 * saves a record of what changed so the modification is tracked rather than
 * silent. The file has to stay inside the project (symlinks included), be
 * plain text, and be under MAX_PATCH_FILE_BYTES.
 *
 * The returned keys are chosen not to collide with this operation's own input
 * keys (file, find, replace, all): in a workflow with mergePreviousResult the
 * result is merged into the next step's payload and wins, so a `file` in the
 * result would overwrite the next patch's `file`. `projectDir` is returned so
 * the next patch, or the build, finds the project without being told.
 */
async function patchHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as PatchPayload;
  const projectDir = payload.projectDir ?? payload.inputDir ?? payload.outputDir;
  if (!projectDir) {
    throw new Error('patch requires "projectDir" (a decoded apktool project directory)');
  }
  if (!payload.file) throw new Error('patch requires "file" (a path inside the project)');
  if (typeof payload.find !== "string" || typeof payload.replace !== "string") {
    throw new Error(
      'patch requires "find" and "replace" (the exact text to look for, and its replacement)',
    );
  }

  const dir = path.resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Directory not found at path: ${dir}`);
  }
  if (!existsSync(path.join(dir, "apktool.yml"))) {
    throw new Error(
      `"${dir}" doesn't look like an apktool project (no apktool.yml found). Did you mean the output of a prior "decode" operation?`,
    );
  }

  const relative = payload.file.split("\\").join("/");
  if (relative.includes("\0") || path.isAbsolute(relative)) {
    throw new Error('"file" must be a relative path inside the project');
  }
  let target: string;
  try {
    target = await realpath(path.resolve(dir, relative));
  } catch {
    throw new Error(`No such file in the project: ${relative}`);
  }
  const root = await realpath(dir);
  const within = path.relative(root, target);
  if (within === ".." || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
    throw new Error('"file" points outside the project');
  }

  const info = await stat(target);
  if (!info.isFile()) throw new Error(`Not a file: ${relative}`);
  if (info.size > MAX_PATCH_FILE_BYTES) {
    throw new Error(
      `${relative} is larger than ${MAX_PATCH_FILE_BYTES} bytes; patch is for text files`,
    );
  }
  const original = await readFile(target);
  if (original.includes(0)) {
    throw new Error(`${relative} looks like a binary file; patch only edits text files`);
  }

  const before = original.toString("utf8");
  const outcome = applyTextPatch(before, payload.find, payload.replace, payload.all === true);
  await writeFile(target, outcome.text, "utf8");

  await appendLineage(root, {
    taskId: task.id,
    patchedFile: relative,
    replacements: outcome.replacements,
    sha256After: sha256(outcome.text),
    at: new Date().toISOString(),
  });

  const record = {
    patchedFile: relative,
    replacements: outcome.replacements,
    changes: outcome.changes,
    sha256Before: sha256(original),
    sha256After: sha256(outcome.text),
  };
  // The saved record is the part that gets recorded as an artifact, so it holds no
  // machine paths; the project directory is added to what's returned afterwards.
  const saved = await withSavedOutput(task, "apktool/patches", record);
  return { ...saved, projectDir: dir };
}

// ---- Gadget injection: frida-gadget on non-root devices ----

const KNOWN_ABIS = ["arm64-v8a", "armeabi-v7a", "x86", "x86_64"];

/**
 * Embeds frida-gadget into a decoded project: copies the gadget .so into
 * lib/<abi>/ and makes the application class load it before anything else
 * runs. After this, the normal build -> sign -> install path gives a
 * non-root device full Frida instrumentation (no frida-server, no root).
 *
 * The loader call is inserted at the top of the entry class's onCreate
 * (its <init> is the fallback): a one-register const-string +
 * invoke-static pair, with the method's .locals bumped to pay for it -
 * the same register-slot discipline smali requires everywhere else here.
 */
async function injectGadgetHandler(task: McpTask): Promise<unknown> {
  const payload = task.payload as unknown as GadgetPayload;
  const projectDir = payload.projectDir ?? payload.inputDir ?? payload.outputDir;
  if (!projectDir) {
    throw new Error('inject-gadget requires "projectDir" (a decoded apktool project directory)');
  }
  if (!payload.gadgetPath) {
    throw new Error(
      'inject-gadget requires "gadgetPath" (a local frida-gadget .so for the target ABI)',
    );
  }

  const dir = path.resolve(projectDir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Directory not found at path: ${dir}`);
  }
  if (!existsSync(path.join(dir, "apktool.yml"))) {
    throw new Error(`"${dir}" doesn't look like an apktool project (no apktool.yml found)`);
  }
  const gadget = path.resolve(payload.gadgetPath);
  if (!existsSync(gadget) || !statSync(gadget).isFile()) {
    throw new Error(`Gadget .so not found at path: ${gadget}`);
  }
  const abi = payload.abi ?? "arm64-v8a";
  if (!KNOWN_ABIS.includes(abi)) {
    throw new Error(`"abi" must be one of: ${KNOWN_ABIS.join(", ")}`);
  }

  // 1. which class loads the gadget
  const manifestPath = path.join(dir, "AndroidManifest.xml");
  const manifest = await readFile(manifestPath, "utf8");
  let entryClass = payload.entryClass;
  if (!entryClass) {
    const app = manifest.match(/<application[^>]*android:name="([^"]+)"/);
    if (!app?.[1]) {
      throw new Error(
        'The manifest declares no application class - pass "entryClass" explicitly (a class in the project whose onCreate can load the gadget)',
      );
    }
    entryClass = app[1];
    // a manifest may name the class relatively (".App") - resolve against the package
    if (entryClass.startsWith(".")) {
      const pkg = manifest.match(/<manifest[^>]*package="([^"]+)"/)?.[1];
      if (!pkg) {
        throw new Error(
          `The manifest names the application class relatively ("${entryClass}") but declares no package - pass "entryClass" explicitly`,
        );
      }
      entryClass = `${pkg}${entryClass}`;
    }
  }

  // 2. find its smali file (projects can have smali, smali_classes2, ...)
  const classPath = `${entryClass.split(".").join("/")}.smali`;
  let smaliFile: string | undefined;
  const smaliRoots = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && /^smali(_classes\d+)?$/.test(e.name))
    .map((e) => path.join(dir, e.name));
  for (const root of smaliRoots) {
    const candidate = path.join(root, classPath);
    if (existsSync(candidate)) {
      smaliFile = candidate;
      break;
    }
  }
  if (!smaliFile) {
    throw new Error(
      `No smali file for "${entryClass}" (${classPath}) in the project's smali directories - is "entryClass" in this APK?`,
    );
  }

  // 3. insert the loadLibrary pair at the top of onCreate (or <init>)
  const smali = await readFile(smaliFile, "utf8");
  const methodHeader = /\.(method|method public|method protected)/;
  const methodRe =
    /^\s*\.method\s+(?:public|protected|private)?\s*(?:static\s+)?(onCreate\(Landroid\/os\/Bundle;\)V|constructor <init>\(\)V)/gm;
  let insertAt = -1;
  let localsLine = "";
  let insertMethodKind = "<init>";
  let match: RegExpExecArray | null;
  // prefer onCreate, fall back to the constructor
  for (const preferred of ["onCreate(Landroid/os/Bundle;)V", "constructor <init>()V"]) {
    methodRe.lastIndex = 0;
    while ((match = methodRe.exec(smali)) !== null) {
      if (match[1] !== preferred) continue;
      // the .locals/.registers declaration follows the method header
      const rest = smali.slice(match.index);
      const localsMatch =
        rest.match(/^\s*\.locals\s+(\d+)\s*$/m) ?? rest.match(/^\s*\.registers\s+(\d+)\s*$/m);
      if (localsMatch && localsMatch.index !== undefined) {
        insertAt = match.index + localsMatch.index + localsMatch[0].length;
        localsLine = localsMatch[0].trim();
        insertMethodKind = preferred.startsWith("onCreate") ? "onCreate" : "<init>";
        break;
      }
    }
    if (insertAt !== -1) break;
  }
  if (insertAt === -1) {
    throw new Error(
      `No onCreate or constructor with a .locals declaration found in ${entryClass}'s smali - cannot place the loader call`,
    );
  }
  // Both declaration styles gain one free register at the same index: with
  // .registers the parameter block sits at the END of the range and shifts up
  // when the total grows, so the freed slot is v<count>; with .locals the new
  // local is v<count> directly.
  const count = Number(localsLine.match(/\d+/)?.[0] ?? 0);
  const newLocal = `v${count}`;
  // Bump the declaration by one to pay for the new register.
  const bumped = localsLine.replace(/\d+/, String(count + 1));
  const loader = [
    bumped,
    `    const-string ${newLocal}, "frida-gadget"`,
    `    invoke-static {${newLocal}}, Ljava/lang/System;->loadLibrary(Ljava/lang/String;)V`,
    "",
  ].join("\n");
  const patchedSmali = smali.slice(0, insertAt) + "\n" + loader + smali.slice(insertAt);
  await writeFile(smaliFile, patchedSmali, "utf8");

  // 4. gadget .so into lib/<abi>/ as the name loadLibrary looks for
  const libDir = path.join(dir, "lib", abi);
  await mkdir(libDir, { recursive: true });
  const gadgetTarget = path.join(libDir, "libfrida-gadget.so");
  copyFileSync(gadget, gadgetTarget);

  // 5. optional gadget config: load a script from the device
  let configPath: string | undefined;
  if (payload.scriptPath) {
    configPath = path.join(libDir, "libfrida-gadget.config.so");
    await writeFile(
      configPath,
      JSON.stringify({
        interaction: { type: "script", path: path.resolve(payload.scriptPath) },
      }),
      "utf8",
    );
  }

  // 6. traceability: this counts as a patch on the project
  await appendLineage(dir, {
    taskId: task.id,
    patchedFile: `lib/${abi}/libfrida-gadget.so + ${path.relative(dir, smaliFile)}`,
    replacements: 1,
    sha256After: sha256(await readFile(gadget)),
    at: new Date().toISOString(),
  });

  const record = {
    entryClass,
    abi,
    gadgetTarget,
    smaliFile: path.relative(dir, smaliFile),
    insertMethod: insertMethodKind,
    configPath,
  };
  const saved = await withSavedOutput(task, "apktool/gadget", record);
  return {
    ...saved,
    projectDir: dir,
    // next steps: the normal build -> sign chain, unchanged
    next: "build this projectDir, then sign the rebuilt APK - install runs the gadget without root",
  };
}

export async function apktoolHandler(task: McpTask): Promise<unknown> {
  switch (task.operation) {
    case "decode":
      return decodeHandler(task);
    case "validate":
      return validateHandler(task);
    case "build":
      return buildHandler(task);
    case "patch":
      return patchHandler(task);
    case "inject-gadget":
      return injectGadgetHandler(task);
    default:
      throw new Error(
        `Unsupported apktool operation "${task.operation}". Supported: "decode", "patch", "validate", "build", "inject-gadget"`,
      );
  }
}
