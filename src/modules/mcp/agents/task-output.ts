import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpTask } from "../../../core/types.js";
import { config } from "../../../core/config.js";

/**
 * Saves an operation's full result as JSON inside its workspace and returns
 * the result with an `outputPath` added, which is what lets the artifact
 * recorder track it (see artifacts/recorder.ts).
 *
 * The file is named after the task id, so every run gets its own file and
 * nothing is overwritten - a finding that cites the resulting artifact keeps
 * seeing exactly what the run produced. The saved JSON is the result as it
 * was before `outputPath` was added.
 *
 * Saving is best-effort: if the file can't be written the original result is
 * returned unchanged, so a full disk never turns a good scan or trace into a
 * failed task.
 */
export async function withSavedOutput<T extends object>(
  task: McpTask,
  subdir: string,
  result: T,
): Promise<T | (T & { outputPath: string })> {
  const outputPath = path.resolve(
    config.WORKSPACES_ROOT,
    task.workspaceId,
    subdir,
    `${task.id}.json`,
  );
  try {
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    return { ...result, outputPath };
  } catch (err) {
    console.warn(
      `[task-output] could not save the output of task ${task.id}:`,
      err instanceof Error ? err.message : err,
    );
    return result;
  }
}
