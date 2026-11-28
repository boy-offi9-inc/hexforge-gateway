import type { BatchEdge } from "./types.js";
import { splitParams, stripGenerics } from "./calls-indexer.js";

/**
 * Parses field accesses out of decompiled Java method bodies and turns them
 * into `field` entities plus `accesses` edges from the accessing `method`
 * entity. Runs alongside the calls indexer, so the method entities already
 * exist under identical signatures.
 *
 * Resolution rules (same trade the calls indexer makes):
 * - a bare or `this.`-prefixed name that matches a field declared in the
 *   same file resolves to the file's own class
 * - `Expr.name` resolves when Expr's last segment is a known class simple
 *   name (static access) or a field whose declared type is a known class
 * - anything else is skipped - a field of a class this artifact does not
 *   contain is not fabricated (unlike call targets, an unresolved field
 *   name is far likelier to be a local variable than evidence)
 *
 * Method bodies are found by brace matching from each declaration, so a
 * field reference inside one method never leaks into a neighbouring one.
 * Comments and string literals are stripped first. Constructors are
 * included - `this.value = ...` in one is still an access.
 *
 * Pure: no filesystem, storage or events.
 */
export const MAX_FIELD_ENTITIES = 60000;
export const MAX_ACCESS_EDGES = 60000;

const METHOD_RE =
  /(?:^|\n|[;{}])[ \t]*(?:@[\w.$]+[ \t\n]*(?:\([^\n)]*\)[ \t\n]*)?)*((?:public|private|protected|static|final|synchronized|abstract|native|default|synthetic|\s)*)\s*(?:<[^>\n]+>\s*)?([A-Za-z_$][\w$]*|(?:boolean|byte|char|short|int|long|float|double|void|[A-Za-z_$][\w$.]*(?:<[^>\n]*>)?(?:\[\])?))\s+([A-Za-z_$][\w$]*)\s*\(([^;{)]*)\)\s*(?:throws\s+[^{;]+)?\s*[;{]/g;

const NOT_METHOD_NAMES = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "synchronized",
  "return",
  "new",
  "do",
  "try",
  "else",
]);

/** `Type name = ...;` / `Type name;` field declarations (shared with the calls indexer). */
const FIELD_RE =
  /(?:^|\n|[;{}])[ \t]*(?:(?:public|private|protected|static|final|volatile|transient|\s)*)\s*([A-Za-z_$][\w$.]*(?:<[^>\n]*>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=[^\n]*)?;/g;

/** Field reference: bare name, `this.name`, or `Expr.name`, NOT a call (no `(` right after). */
const ACCESS_RE = /(?:\bthis\s*\.\s*)?(?:([A-Za-z_$][\w$.]*)\s*\.\s*)?([A-Za-z_$][\w$]*)(?!\s*\()/g;

function clean(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
}

/** Map of field name -> bare declared type for one file. */
export function parseFieldDeclarations(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(FIELD_RE)) {
    const [, type, name] = match;
    if (!type || !name || NOT_METHOD_NAMES.has(name)) continue;
    const bare = stripGenerics(type).replace(/\[\]/g, "");
    if (!out.has(name) && /^[A-Za-z_$][\w$.]*$/.test(bare)) out.set(name, bare);
  }
  return out;
}

/**
 * Finds each declared method's body by brace matching and returns the
 * signature (identical to the calls indexer's method entity names) plus the
 * body text. Abstract/native declarations (`;` bodies) yield no body.
 */
export function parseMethodBodies(
  source: string,
  selfClass: string,
): { signature: string; body: string }[] {
  const cleaned = clean(source);
  const out: { signature: string; body: string }[] = [];
  for (const match of cleaned.matchAll(METHOD_RE)) {
    const [, , , name, params] = match;
    if (!name || NOT_METHOD_NAMES.has(name)) continue;
    const signature = `${selfClass}.${name}(${splitParams(params ?? "").join(",")})`;
    const open = cleaned.indexOf("{", (match.index ?? 0) + match[0].length - 1);
    // no `{` anywhere near: abstract/native or a stray match - no body
    if (open < 0) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < cleaned.length; i++) {
      if (cleaned[i] === "{") depth++;
      else if (cleaned[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue; // unbalanced (truncated file) - skip, never guess
    out.push({ signature, body: cleaned.slice(open + 1, end) });
  }
  return out;
}

export interface AccessesIndexInput {
  /** Relative path -> source text, as the Java indexer reads them. */
  files: Map<string, string>;
  maxFieldEntities?: number;
  maxAccessEdges?: number;
}

export interface AccessesIndexResult {
  entities: {
    type: "field";
    name: string;
    attributes: Record<string, string | number | boolean>;
  }[];
  edges: BatchEdge[];
  truncated: boolean;
}

/**
 * Turns method-body field accesses into graph pieces:
 *
 * - one `field` entity per accessed field, named `com.acme.Foo.value`
 * - an `accesses` edge from the accessing `method` entity to the field
 *
 * Edges only resolve against the same artifact's class set, and only
 * against fields declared in a file this artifact contains - locals are
 * never promoted to fields.
 */
export function parseFieldAccessGraph({
  files,
  maxFieldEntities = MAX_FIELD_ENTITIES,
  maxAccessEdges = MAX_ACCESS_EDGES,
}: AccessesIndexInput): AccessesIndexResult {
  const entities: AccessesIndexResult["entities"] = [];
  const edges: BatchEdge[] = [];
  const fieldSeen = new Set<string>();
  let truncated = false;

  const addField = (owner: string, name: string, type: string | undefined) => {
    const key = `${owner}.${name}`;
    if (!fieldSeen.has(key)) {
      if (entities.length >= maxFieldEntities) {
        truncated = true;
        return false;
      }
      fieldSeen.add(key);
      entities.push({
        type: "field",
        name: key,
        attributes: type ? { type } : {},
      });
    }
    return true;
  };

  // class simple name -> fully qualified name, for static-access resolution
  const classBySimple = new Map<string, string>();
  for (const file of files.keys()) {
    if (!file.endsWith(".java")) continue;
    const fq = file.slice(0, -".java".length).split("/").join(".");
    const simple = fq.split(".").pop()!;
    if (!classBySimple.has(simple)) classBySimple.set(simple, fq);
  }

  for (const [file, content] of files) {
    if (!file.endsWith(".java")) continue;
    const selfPkg = file.includes("/") ? file.slice(0, file.lastIndexOf("/")).split("/").join(".") : "";
    const pkgPrefix = selfPkg ? selfPkg + "." : "";
    const selfClass = pkgPrefix + file.slice(file.lastIndexOf("/") + 1, -".java".length);
    const cleaned = clean(content);
    const bodies = parseMethodBodies(content, selfClass);
    // a declaration inside a method body is a local, not a field: exclude
    // every offset that falls in a method body before matching fields
    const bodyRanges = bodies.map((b) => {
      const start = cleaned.indexOf(b.body);
      return start >= 0 ? [start, start + b.body.length] : null;
    });
    const fields = new Map<string, string>();
    for (const match of cleaned.matchAll(FIELD_RE)) {
      const [, type, name] = match;
      if (!type || !name || NOT_METHOD_NAMES.has(name)) continue;
      const at = (match.index ?? 0) + match[0].length - 1;
      if (bodyRanges.some((r) => r && at > r[0] && at < r[1])) continue;
      const bare = stripGenerics(type).replace(/\[\]/g, "");
      if (!fields.has(name) && /^[A-Za-z_$][\w$.]*$/.test(bare)) fields.set(name, bare);
    }

    for (const { signature, body } of bodies) {
      const methodRef = { type: "method" as const, name: signature };
      for (const match of body.matchAll(ACCESS_RE)) {
        if (edges.length >= maxAccessEdges) {
          truncated = true;
          break;
        }
        const [, expr = "", name] = match;
        if (!name || NOT_METHOD_NAMES.has(name)) continue;
        if (expr === "" || expr === "this" || expr === "super") {
          // bare or this.name: only fields declared in this file count -
          // otherwise every local variable would become a field entity
          const type = fields.get(name);
          if (!type) continue;
          if (!addField(selfClass, name, type)) break;
          edges.push({
            from: methodRef,
            to: { type: "field", name: `${selfClass}.${name}` },
            relation: "accesses",
          });
          continue;
        }
        // Expr.name: resolve Expr's last segment to a known class
        const last = expr.split(".").pop()!;
        const target = classBySimple.get(last) ?? classBySimple.get(fields.get(last) ?? "");
        if (!target) continue;
        if (!addField(target, name, undefined)) break;
        edges.push({
          from: methodRef,
          to: { type: "field", name: `${target}.${name}` },
          relation: "accesses",
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { entities, edges, truncated };
}
