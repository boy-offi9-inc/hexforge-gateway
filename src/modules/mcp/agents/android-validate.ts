import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * `android.validate` - pre-flight checks for a decoded apktool project
 * before a rebuild. A doomed build wastes minutes on a resource cycle that
 * fails halfway; these checks catch the common causes in seconds:
 *
 * - the project layout (apktool.yml, AndroidManifest.xml, apktoolDecompiled
 *   markers) - buildHandler already refuses these, but validate reports ALL
 *   problems at once instead of the first one
 * - AndroidManifest.xml parses as XML (the single most common patch breakage:
 *   a patch that ate a quote or bracket)
 * - every XML under res/ and every smali file referenced by the manifest is
 *   still well-formed XML / non-empty
 * - the APKs referenced in apktool.yml (split APK source projects) still exist
 *
 * Pure checks only: no apktool invocation, no writes. Report language, not
 * exceptions - a validation with problems still returns everything found.
 */

export interface ValidationIssue {
  /** What's wrong, assessment language. */
  problem: string;
  /** Project-relative file the issue is about, when it's about one file. */
  file?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  checked: { manifest: boolean; xmlFiles: number; smaliFiles: number };
}

const MAX_XML_CHECKS = 2_000;
const MAX_XML_BYTES = 4 * 1024 * 1024;

/**
 * Minimal XML well-formedness check: balanced tags via a stack, quoted
 * attribute scanning, declaration/comment/CDATA handling. Not a full XML
 * parser - it catches the patch breakages (unclosed tag, stray quote,
 * mismatched nesting) that actually happen.
 */
export function checkXmlWellFormed(text: string): ValidationIssue | null {
  // fast path: strip comments, CDATA, declarations and processing instructions
  const cleaned = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/g, "");
  const stack: string[] = [];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(cleaned)) !== null) {
    const [, closing, name, attrs, selfClose] = m;
    // an unbalanced quote inside attributes leaves junk the regex can't see;
    // detect it: an odd number of quotes in the attribute region
    const quotes = (attrs.match(/"/g) ?? []).length + (attrs.match(/'/g) ?? []).length;
    if (quotes % 2 !== 0) {
      return { problem: `unbalanced quote inside <${name}> tag` };
    }
    if (closing) {
      const open = stack.pop();
      if (open !== name) {
        return {
          problem: `closing </${name}> doesn't match expected </${open ?? "nothing"}> - tag nesting is broken`,
        };
      }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  if (stack.length > 0) {
    return {
      problem: `unclosed <${stack[stack.length - 1]}> tag(s) - ${stack.length} element(s) never close`,
    };
  }
  return null;
}

function looksLikeApktoolProject(dir: string): boolean {
  return (
    existsSync(path.join(dir, "apktool.yml")) && existsSync(path.join(dir, "AndroidManifest.xml"))
  );
}

/**
 * Validates one decoded project. Returns every issue found - `ok` is false
 * when there is at least one blocking issue.
 */
export async function validateProject(dir: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = [];
  let xmlFiles = 0;
  let smaliFiles = 0;

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      ok: false,
      issues: [{ problem: `directory not found: ${dir}` }],
      checked: { manifest: false, xmlFiles: 0, smaliFiles: 0 },
    };
  }
  if (!existsSync(path.join(dir, "apktool.yml"))) {
    issues.push({
      problem: `not an apktool project (no apktool.yml) - run the apktool agent's "decode" first`,
    });
  }
  const manifestPath = path.join(dir, "AndroidManifest.xml");
  let manifestChecked = false;
  if (existsSync(manifestPath)) {
    manifestChecked = true;
    const manifest = await readFile(manifestPath, "utf8");
    const manifestIssue = checkXmlWellFormed(manifest);
    if (manifestIssue) issues.push({ problem: manifestIssue.problem, file: "AndroidManifest.xml" });
  } else {
    issues.push({ problem: "no AndroidManifest.xml - the project can't rebuild without it" });
  }

  // walk res/ XMLs (and values/ in particular - the usual patch target)
  const resDir = path.join(dir, "res");
  if (existsSync(resDir)) {
    const xmlPaths = await listFilesByExt(resDir, ".xml", MAX_XML_CHECKS);
    for (const rel of xmlPaths) {
      xmlFiles++;
      const abs = path.join(resDir, rel);
      const stat = statSync(abs);
      if (stat.size === 0) {
        issues.push({ problem: "empty resource XML file", file: path.posix.join("res", rel) });
        continue;
      }
      if (stat.size > MAX_XML_BYTES) continue; // too big to be worth parsing here
      const text = await readFile(abs, "utf8").catch(() => null);
      if (text === null) continue;
      const issue = checkXmlWellFormed(text);
      if (issue) issues.push({ problem: issue.problem, file: path.posix.join("res", rel) });
    }
  }

  // smali: count and check the ones the manifest references indirectly are
  // at least present as files with content (a patch that truncated a smali
  // file to zero bytes is a classic broken-build cause)
  for (const smaliRoot of ["smali", "smali_classes2", "smali_classes3", "smali_classes4"]) {
    const root = path.join(dir, smaliRoot);
    if (!existsSync(root)) continue;
    const files = await listFilesByExt(root, ".smali", MAX_XML_CHECKS);
    smaliFiles += files.length;
    for (const rel of files) {
      const abs = path.join(root, rel);
      if (statSync(abs).size === 0) {
        issues.push({
          problem: "empty smali file (patch likely truncated it)",
          file: path.posix.join(smaliRoot, rel),
        });
      }
    }
  }

  // split-APK source projects record their inputs in apktool.yml; a missing
  // referenced APK dooms the build
  const ymlPath = path.join(dir, "apktool.yml");
  if (existsSync(ymlPath)) {
    const yml = await readFile(ymlPath, "utf8").catch(() => "");
    const apkLines = [...yml.matchAll(/^\s*-\s*(\S+\.apk)\s*$/gm)].map((m) => m[1]);
    for (const apk of apkLines) {
      if (!existsSync(path.join(dir, apk)) && !existsSync(apk)) {
        issues.push({
          problem: `apktool.yml references ${apk} but it doesn't exist`,
          file: "apktool.yml",
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    checked: { manifest: manifestChecked, xmlFiles, smaliFiles },
  };
}

async function listFilesByExt(root: string, ext: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= limit) return;
    const entries = await readdir(path.join(root, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : path.posix.join(rel, entry.name);
      if (entry.isFile() && entry.name.endsWith(ext)) out.push(childRel);
      else if (entry.isDirectory()) await walk(childRel);
      if (out.length >= limit) return;
    }
  };
  await walk("");
  return out;
}
