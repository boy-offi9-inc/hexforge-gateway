/** One replacement made by a patch, for the saved record. */
export interface PatchChange {
  /** 1-based line the matched text started on. */
  line: number;
  before: string;
  after: string;
}

export interface PatchOutcome {
  text: string;
  replacements: number;
  /** The first MAX_CHANGES replacements, with each side shortened. */
  changes: PatchChange[];
}

/** Files over this size are not patched. */
export const MAX_PATCH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CHANGES = 50;
const SNIPPET_CHARS = 200;

const snippet = (s: string) => (s.length > SNIPPET_CHARS ? `${s.slice(0, SNIPPET_CHARS)}...` : s);

/**
 * Replaces exact text. It fails rather than guess: the text has to be there, and
 * has to be there exactly once unless the caller says `all`. Matches are plain
 * text, not patterns, and don't overlap.
 */
export function applyTextPatch(
  text: string,
  find: string,
  replace: string,
  all = false,
): PatchOutcome {
  if (!find) throw new Error('"find" must not be empty');

  const starts: number[] = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + find.length)) {
    starts.push(at);
  }
  if (starts.length === 0) throw new Error('The "find" text was not found in the file');
  if (starts.length > 1 && !all) {
    throw new Error(
      `The "find" text appears ${starts.length} times; make it more specific, or set "all": true to replace every one`,
    );
  }

  const changes: PatchChange[] = [];
  for (const start of starts.slice(0, MAX_CHANGES)) {
    const line = text.slice(0, start).split("\n").length;
    changes.push({ line, before: snippet(find), after: snippet(replace) });
  }
  return {
    text: text.split(find).join(replace),
    replacements: starts.length,
    changes,
  };
}
