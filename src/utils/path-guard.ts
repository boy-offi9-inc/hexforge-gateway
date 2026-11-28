import path from "node:path";

/**
 * Shared path containment guard, used by every writer that turns an
 * externally supplied id or filename into a path under WORKSPACES_ROOT.
 * Extracted from the inbox watcher so the guarantee is written once and
 * every caller inherits it: a hostile or malformed id can never steer a
 * write outside the workspace root.
 */

export function sanitizeWorkspaceId(workspaceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(workspaceId)) {
    throw new Error(`Invalid workspace id: ${JSON.stringify(workspaceId.slice(0, 64))}`);
  }
  return workspaceId;
}

/**
 * Joins segments under a root and proves the result is still inside it.
 * The regex in sanitizeWorkspaceId already rejects traversal shapes; this
 * is the containment check that makes the guarantee visible to both a
 * reader and a static analyzer: whatever the segments are, the returned
 * path is inside `root` or the call throws.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const resolved = path.resolve(root, ...segments);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Refusing path outside ${base}: ${JSON.stringify(resolved)}`);
  }
  return resolved;
}
