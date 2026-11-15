import path from "node:path";
import { readFile } from "node:fs/promises";
import type { BatchEdge, BatchEntity } from "./types.js";

/**
 * Parses class declarations out of decompiled Java files and turns
 * `extends`/`implements` clauses into `inherits` edges between class
 * entities. Runs after the sources indexer, so the class entities already
 * exist; edges to classes that were not indexed (JDK types, other
 * artifacts' classes) are still written - the graph validates ends only
 * inside one batch, and a superclass name is itself evidence.
 *
 * Pure: no filesystem, storage or events.
 */
export const MAX_EDGES = 40000;

const CLASS_RE =
  /\b((?:public|final|abstract|sealed|open|internal|private|protected|static|\s)*)(class|interface|enum)\s+([A-Za-z_$][\w$]*)\s*(<[^>{]*>)?\s*([^{;/]*?)\{/;
const ANON_RE = /\bnew\s+[A-Za-z_$][\w$.<>]*\s*\(\s*\)\s*\{/;

/**
 * Extracts declared class names and their superclass / interfaces from one
 * decompiled source file's text. Anonymous classes are skipped.
 */
export function parseInheritance(
  source: string,
): { name: string; extends: string[]; implements: string[] } | null {
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
  const match = CLASS_RE.exec(cleaned);
  if (!match) return null;
  const name = match[3];
  const clauses = match[5] ?? "";
  const extendsMatch = /(?:^|\s)extends\s+([^]*?)(?=\simplements\s|$)/.exec(clauses);
  const implementsMatch = /implements\s+([^]*?)$/.exec(clauses);
  return {
    name,
    extends: extendsMatch ? splitTypes(extendsMatch[1]) : [],
    implements: implementsMatch ? splitTypes(implementsMatch[1]) : [],
  };
}

function splitTypes(clause: string): string[] {
  return clause
    .split(",")
    .map((t) => t.trim().split("<")[0].trim())
    .filter((t) => /^[A-Za-z_$][\w$.]*$/.test(t) && !ANON_RE.test(t));
}

/**
 * Scans decompiled source files (relative paths + content) and produces
 * `inherits` edges between fully-qualified class entities. A bare name in
 * an `extends`/`implements` clause resolves against the same package as
 * the declaring class (jadx writes imports out, and same-package classes
 * need none).
 */
export function parseInheritanceEdges(
  files: Map<string, string>,
  maxEdges = MAX_EDGES,
): { edges: BatchEdge[]; truncated: boolean } {
  const edges: BatchEdge[] = [];
  let truncated = false;
  for (const [file, content] of files) {
    if (!file.endsWith(".java")) continue;
    const parsed = parseInheritance(content);
    if (!parsed) continue;
    const dir = path.posix.dirname(file);
    const pkg = dir !== "." ? dir.split("/").join(".") + "." : "";
    const self = { type: "class" as const, name: pkg + parsed.name };
    for (const superName of [...parsed.extends, ...parsed.implements]) {
      if (edges.length >= maxEdges) {
        truncated = true;
        break;
      }
      edges.push({
        from: self,
        to: { type: "class", name: resolveName(superName, pkg) },
        relation: "inherits",
      });
    }
  }
  return { edges, truncated };
}

/** Fully-qualified already -> keep as written; bare name -> same package as the subclass. */
function resolveName(superName: string, pkgPrefix: string): string {
  return superName.includes(".") ? superName : pkgPrefix + superName;
}
