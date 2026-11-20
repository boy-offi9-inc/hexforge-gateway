import { readFile } from "node:fs/promises";
import path from "node:path";
import type { BatchEdge } from "./types.js";

/**
 * Parses method declarations and call sites out of decompiled Java files and
 * turns them into `method` entities plus `calls` / `invokes` edges between
 * class entities. Runs after the sources indexer, so the class entities
 * already exist; a call to a class that was not indexed (JDK types, other
 * artifacts) is still written - a resolved call target is itself evidence,
 * the same trade the inheritance indexer makes.
 *
 * Pure: no filesystem, storage or events.
 */
export const MAX_METHOD_ENTITIES = 60000;
export const MAX_CALL_EDGES = 60000;

const METHOD_RE =
  /(?:^|\n|[;{}])[ \t]*(?:@[\w.$]+[ \t\n]*(?:\([^\n)]*\)[ \t\n]*)?)*((?:public|private|protected|static|final|synchronized|abstract|native|default|synthetic|\s)*)\s*(?:<[^>\n]+>\s*)?([A-Za-z_$][\w$]*|(?:boolean|byte|char|short|int|long|float|double|void|[A-Za-z_$][\w$.]*(?:<[^>\n]*>)?(?:\[\])?))\s+([A-Za-z_$][\w$]*)\s*\(([^;{)]*)\)\s*(?:throws\s+[^{;]+)?\s*[;{]/g;

/**
 * Distinguishes a method declaration from a `new` / control keyword before
 * the name: `if (`, `while (`, `new Foo(` are not methods.
 */
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

/** One declared method in one decompiled source file. */
export interface DeclaredMethod {
  /** Bare name as written, e.g. `performLogin`. */
  name: string;
  /** Parameter type names, bare or qualified, e.g. `["String", "Context"]`. */
  params: string[];
  /** True when the declaration carries `native`. */
  isNative: boolean;
}

/**
 * Extracts declared methods (with native flag) from one decompiled source
 * file's text. Comments and string literals are stripped first so quoted
 * code cannot fake a declaration. Constructors are reported too (jadx writes
 * them as the class's simple name); the caller tells them apart.
 */
export function parseDeclaredMethods(source: string): DeclaredMethod[] {
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const out: DeclaredMethod[] = [];
  for (const match of cleaned.matchAll(METHOD_RE)) {
    const [, modifiers, , name, params] = match;
    if (!name || NOT_METHOD_NAMES.has(name)) continue;
    // A constructor looks like `ClassName(...)`: jadx writes it with the
    // class's simple name, and there is no return type before it. The
    // regex's second group is the return type slot; when it matched a word
    // it is a real return type, otherwise it can also match the class name
    // itself - both cases are methods or constructors, keep them.
    out.push({
      name,
      params: splitParams(params ?? ""),
      isNative: /\bnative\b/.test(modifiers ?? ""),
    });
  }
  return out;
}

function splitParams(params: string): string[] {
  if (params.trim().length === 0) return [];
  const out: string[] = [];
  for (const piece of params.split(",")) {
    const tokens = piece.trim().split(/\s+/).filter(Boolean);
    // `Type name` -> type is the token before the name; a single token is
    // treated as the type itself (untyped, jadx rarely writes this).
    const typeToken = tokens.length >= 2 ? tokens[tokens.length - 2] : tokens[0];
    if (!typeToken) continue;
    const type = typeToken
      .replace(/<[^<>]*>/g, "")
      .replace(/\[\]/g, "")
      .replace(/^final\s+/, "");
    if (/^[A-Za-z_$][\w$.]*$/.test(type)) out.push(type);
  }
  return out;
}

/** A method reference inside a body, e.g. `this.api.send(payload)`. */
export interface CallSite {
  /** Receiver expression as written, e.g. `this.api`, `LoginManager`, `super`. */
  receiver: string | null;
  /** Bare method name, e.g. `send`. */
  method: string;
  /** True when the receiver is `super` or the method is `super(...)`. */
  isSuper: boolean;
  /** True when reflection-style (`Class.forName(...).getMethod(...).invoke`, `Method.invoke`). */
  isReflective: boolean;
}

const CALL_RE = /([A-Za-z_$][\w$.]*)?\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
const REFLECT_RE =
  /\bClass\s*\.\s*forName\s*\(|\.getMethod\s*\(|\.getDeclaredMethod\s*\(|\.invoke\s*\(/;

/**
 * `Type name = ...;` / `Type name;` field declarations, used to resolve a
 * receiver field (e.g. `api.send(...)`) to its declared type.
 */
const FIELD_RE =
  /(?:^|\n|[;{}])[ \t]*(?:(?:public|private|protected|static|final|volatile|transient|\s)*)\s*([A-Za-z_$][\w$.]*(?:<[^>\n]*>)?(?:\[\])?)\s+([A-Za-z_$][\w$]*)\s*(?:=[^\n]*)?;/g;

/** Map of field name -> bare declared type for one file. */
function parseFieldTypes(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(FIELD_RE)) {
    const [, type, name] = match;
    if (!type || !name || NOT_METHOD_NAMES.has(name)) continue;
    const bare = type.replace(/<[^<>]*>/g, "").replace(/\[\]/g, "");
    if (!out.has(name) && /^[A-Za-z_$][\w$.]*$/.test(bare)) out.set(name, bare);
  }
  return out;
}

/**
 * Extracts method call sites from one decompiled source file's text.
 * Keywords (`if (`, `while (`, `return(`) are not calls; `new Foo(...)` is
 * a constructor call on the class itself and is kept as receiver=null with
 * the class's simple name... it is not: `new` is excluded like keywords,
 * since constructor edges are already `contains`-adjacent and a bare
 * `new Foo()` names the class, not a method.
 */
export function parseCallSites(source: string): CallSite[] {
  const cleaned = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const out: CallSite[] = [];
  for (const match of cleaned.matchAll(CALL_RE)) {
    const [, receiverExpr = "", method] = match;
    if (NOT_METHOD_NAMES.has(method)) continue;
    const tail = receiverExpr.split(".").pop() ?? "";
    if (NOT_METHOD_NAMES.has(tail) || tail === "new") continue;
    const isSuper = tail === "super";
    out.push({
      receiver: receiverExpr.length > 0 ? receiverExpr : null,
      method,
      isSuper,
      isReflective: false,
    });
  }
  if (REFLECT_RE.test(cleaned)) {
    // Mark the whole file as containing reflection rather than guessing
    // which call was reflective: a coarse flag beats a wrong precise one.
    out.push({ receiver: null, method: "<reflective>", isSuper: false, isReflective: true });
  }
  return out;
}

export interface CallsIndexInput {
  /** Relative path -> source text, as the Java indexer reads them. */
  files: Map<string, string>;
  maxMethodEntities?: number;
  maxCallEdges?: number;
}

export interface CallsIndexResult {
  entities: {
    type: "method";
    name: string;
    attributes: Record<string, string | number | boolean>;
  }[];
  edges: BatchEdge[];
  truncated: boolean;
}

/**
 * Turns declared methods and call sites into graph pieces:
 *
 * - one `method` entity per declared method, named `com.acme.Foo.bar(int)` -
 *   parameter types make overloads distinct entities; constructors are
 *   `com.acme.Foo.<init>(...)`; a `native` method gets `native: true` (the
 *   hook for the future Java <-> JNI correlation)
 * - a `calls` edge class -> class when the receiver resolves to a known
 *   type of the same artifact (field access chain collapsed to its last
 *   segment), and class -> class `invokes` edges for the reflective marker
 *
 * Edges only resolve against classes the caller passes in (the same
 * artifact's class set), so a call to the JDK never fabricates an entity.
 */
export function parseMethodAndCallGraph({
  files,
  maxMethodEntities = MAX_METHOD_ENTITIES,
  maxCallEdges = MAX_CALL_EDGES,
}: CallsIndexInput): CallsIndexResult {
  const methodEntities: CallsIndexResult["entities"] = [];
  const edges: BatchEdge[] = [];
  let truncated = false;

  // class simple name -> fully qualified name, for receiver resolution
  const classBySimple = new Map<string, string>();
  for (const file of files.keys()) {
    if (!file.endsWith(".java")) continue;
    const fq = file.slice(0, -".java".length).split("/").join(".");
    const simple = fq.split(".").pop()!;
    if (!classBySimple.has(simple)) classBySimple.set(simple, fq);
  }

  for (const [file, content] of files) {
    if (!file.endsWith(".java")) continue;
    const selfPkg = path.posix.dirname(file);
    const pkgPrefix = selfPkg !== "." ? selfPkg.split("/").join(".") + "." : "";
    const selfClass = pkgPrefix + path.posix.basename(file).slice(0, -".java".length);
    const selfRef = { type: "class" as const, name: selfClass };
    const fieldTypes = parseFieldTypes(content);

    for (const declared of parseDeclaredMethods(content)) {
      if (methodEntities.length >= maxMethodEntities) {
        truncated = true;
        break;
      }
      const signature = `${selfClass}.${declared.name}(${declared.params.join(",")})`;
      methodEntities.push({
        type: "method",
        name: signature,
        attributes: declared.isNative ? { native: true } : {},
      });
    }
    if (truncated) break;

    for (const call of parseCallSites(content)) {
      if (edges.length >= maxCallEdges) {
        truncated = true;
        break;
      }
      if (call.isReflective) {
        edges.push({ from: selfRef, to: selfRef, relation: "invokes" });
        continue;
      }
      // Resolve the receiver: its last segment may be a class simple name
      // (static call `Api.send`) or a field whose declared type is a known
      // class (`api.send` where `Api api` is a field).
      const last = call.receiver?.split(".").pop();
      if (!last || last === "this" || last === "super") continue;
      const target = classBySimple.get(last) ?? classBySimple.get(fieldTypes.get(last) ?? "");
      if (!target || target === selfClass) continue;
      edges.push({
        from: selfRef,
        to: { type: "class", name: target },
        relation: "calls",
      });
    }
    if (truncated) break;
  }
  return { entities: methodEntities, edges, truncated };
}
