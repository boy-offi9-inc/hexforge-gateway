import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getArtifact } from "../artifacts/artifact.service.js";
import type { Artifact } from "../artifacts/types.js";
import { getEntity } from "../graph/graph.service.js";
import type {
  Evidence,
  EvidenceCheck,
  Finding,
  VerificationReport,
  VerificationStatus,
} from "./types.js";

/** Files larger than this are not read, so a line in them stays unverified. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Check = { status: VerificationStatus; reason: string };

/**
 * Splits `com/acme/Api.java:12`, `com/acme/Api.java:12-20` or
 * `com/acme/Api.java:12:5` (a trailing column is ignored) into a file and an
 * optional line range. Anything else is taken as a plain file path.
 */
export function parseLocation(location: string): {
  file: string;
  startLine?: number;
  endLine?: number;
} {
  const trimmed = location.trim();
  const match = /^(.+?):(\d+)(?:-(\d+))?(?::\d+)?$/.exec(trimmed);
  if (!match) return { file: trimmed };
  return {
    file: match[1] ?? trimmed,
    startLine: Number(match[2]),
    endLine: match[3] ? Number(match[3]) : undefined,
  };
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const ch of text) if (ch === "\n") lines++;
  return text.endsWith("\n") ? lines : lines + 1;
}

async function checkLines(
  file: string,
  size: number,
  maxBytes: number,
  startLine?: number,
  endLine?: number,
): Promise<Check> {
  if (startLine === undefined) return { status: "verified", reason: "the file exists" };
  if (startLine < 1) return { status: "failed", reason: "line numbers start at 1" };
  if (endLine !== undefined && endLine < startLine) {
    return { status: "failed", reason: `line range ${startLine}-${endLine} is backwards` };
  }
  if (size > maxBytes) {
    return {
      status: "unverified",
      reason: `the file is larger than ${maxBytes} bytes, so the line was not checked`,
    };
  }

  const lines = countLines(await readFile(file, "utf8"));
  const last = endLine ?? startLine;
  if (last > lines) {
    return {
      status: "failed",
      reason: `line ${last} is past the end of the file (${lines} lines)`,
    };
  }
  const where = endLine === undefined ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  return {
    status: "verified",
    reason: `the file exists and ${where} is within it (${lines} lines)`,
  };
}

/**
 * Checks that a location really exists inside an artifact: the file is there
 * and the line (or range) falls within it. It is relative to the artifact
 * directory, or to its `sources/` folder for a jadx decompile - the same
 * paths the graph indexer records. Nothing outside the artifact directory is
 * ever read, symlinks included.
 *
 * "verified" means the cited place exists. It does not mean the claim about it
 * is true.
 */
export async function checkLocation(
  artifact: Pick<Artifact, "path" | "pathType">,
  location: string,
  maxBytes = MAX_FILE_BYTES,
): Promise<Check> {
  if (artifact.pathType !== "directory") {
    return {
      status: "unverified",
      reason: "the artifact is a single file, so a location inside it can't be checked",
    };
  }
  let root: string;
  try {
    root = await realpath(artifact.path);
  } catch {
    return { status: "unverified", reason: "the artifact directory is missing on disk" };
  }

  const { file, startLine, endLine } = parseLocation(location);
  const relative = file.split("\\").join("/");
  if (!relative || relative.includes("\0") || path.isAbsolute(relative)) {
    return { status: "failed", reason: "a location must be a relative path inside the artifact" };
  }

  for (const base of [root, path.join(root, "sources")]) {
    let real: string;
    try {
      real = await realpath(path.resolve(base, relative));
    } catch {
      continue;
    }
    if (!isInside(root, real)) {
      return { status: "failed", reason: "the location points outside the artifact" };
    }
    const info = await stat(real);
    if (!info.isFile()) continue;
    return checkLines(real, info.size, maxBytes, startLine, endLine);
  }
  return { status: "failed", reason: `no such file in the artifact: ${relative}` };
}

/**
 * Checks that a cited graph entity still exists in the workspace and is still
 * recorded as observed in the artifact it is cited with. Nothing but a
 * hand-edited record can break the second part (an entity's artifact ids only
 * grow), so this mostly guards against stored data drifting.
 */
async function checkEntity(workspaceId: string, evidence: Evidence): Promise<Check | undefined> {
  if (!evidence.entityId) return undefined;
  const entity = await getEntity(evidence.entityId);
  if (!entity || entity.workspaceId !== workspaceId) {
    return { status: "failed", reason: "the cited entity no longer exists" };
  }
  if (!entity.artifactIds.includes(evidence.artifactId)) {
    return {
      status: "failed",
      reason: `the entity ${entity.name} is not recorded as observed in the cited artifact`,
    };
  }
  return { status: "verified", reason: `the entity ${entity.name} exists and was observed in it` };
}

/**
 * One result for an evidence item that has both a location and an entity. A
 * failure in either fails the item. A location that couldn't be checked stays
 * unverified - a good entity doesn't make up for a place nobody looked at.
 */
export function combineChecks(location: Check, entity: Check | undefined): Check {
  if (!entity) return location;
  const failed = [location, entity].filter((c) => c.status === "failed");
  if (failed.length > 0) {
    return { status: "failed", reason: failed.map((c) => c.reason).join("; ") };
  }
  return { status: location.status, reason: `${location.reason}; ${entity.reason}` };
}

export function summarize(items: EvidenceCheck[]): VerificationReport["summary"] {
  if (items.some((i) => i.status === "failed")) return "failed";
  const verified = items.filter((i) => i.status === "verified").length;
  if (verified === 0) return "unverified";
  return verified === items.length ? "verified" : "partial";
}

/**
 * Checks each piece of a finding's evidence against the artifact it cites.
 * Read-only: it reports, and never changes the finding (its status is whatever
 * someone or something set it to).
 */
export async function verifyFinding(finding: Finding): Promise<VerificationReport> {
  const items: EvidenceCheck[] = [];
  for (const [index, evidence] of finding.evidence.entries()) {
    const base = {
      index,
      artifactId: evidence.artifactId,
      entityId: evidence.entityId,
      location: evidence.location,
    };
    const artifact = await getArtifact(evidence.artifactId);
    if (!artifact || artifact.workspaceId !== finding.workspaceId) {
      items.push({ ...base, status: "failed", reason: "the cited artifact no longer exists" });
      continue;
    }
    const location: Check = evidence.location
      ? await checkLocation(artifact, evidence.location)
      : {
          status: "unverified",
          reason: "no location was given, so only the artifact's existence was checked",
        };
    const entity = await checkEntity(finding.workspaceId, evidence);
    items.push({ ...base, ...combineChecks(location, entity) });
  }
  return {
    findingId: finding.id,
    checkedAt: new Date().toISOString(),
    summary: summarize(items),
    items,
  };
}
