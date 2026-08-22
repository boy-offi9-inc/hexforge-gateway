/**
 * Shared "friendly error" formatting for every agent that shells out to a
 * CLI tool (jadx, apktool, adb, frida, apkid). Node's child_process
 * rejection puts the real failure reason on err.stderr/err.stdout, not
 * err.message (which is just "Command failed: <the command>") - every
 * one of these agents needed the same fix, so it lives here once instead
 * of five near-identical copies that would silently drift out of sync as
 * one gets tweaked and the others don't.
 */

export interface ExecFailure {
  code?: string;
  stderr?: string | Buffer;
  stdout?: string | Buffer;
  // Set when Node's own execFile `timeout` option kills the process (see
  // frida.agent.ts's "trace" - a timeout there isn't a real failure, it's
  // the expected way a bounded capture ends).
  killed?: boolean;
  signal?: string;
}

/**
 * @param binaryName The executable that failed, e.g. "jadx" - used both
 *   in the ENOENT message and to prefix the generic failure message.
 * @param notFoundHint Install instructions shown only for ENOENT (binary
 *   missing from PATH entirely) - everything else gets the real
 *   stderr/stdout instead, since that's almost always more useful than a
 *   generic install hint once the binary is actually found and running.
 */
export function friendlyExecError(binaryName: string, notFoundHint: string, err: unknown): Error {
  const failure = err as ExecFailure;
  if (failure?.code === "ENOENT") {
    return new Error(`"${binaryName}" not found on PATH. ${notFoundHint}`);
  }
  const detail = (failure?.stderr || failure?.stdout || "").toString().trim().slice(-2000);
  const baseMessage = err instanceof Error ? err.message : String(err);
  return new Error(detail ? `${binaryName} failed: ${baseMessage}\n\n${detail}` : `${binaryName} failed: ${baseMessage}`);
}
