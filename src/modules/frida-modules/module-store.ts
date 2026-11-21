import { getStorage, localStorageProvider } from "../../providers/storage.provider.js";

/**
 * The Frida module store: trace scripts as versioned, reusable workflow
 * assets instead of one-shot payloads. The lifecycle is draft -> tested ->
 * versioned:
 *
 * - `saveDraft` stores a script under a name with `status: "draft"`
 * - a trace run against it (the frida agent) records the run as provenance
 *   via `recordTestRun` - the module keeps which task ran it and when
 * - `promote` turns a tested draft into a versioned module (semver bump
 *   chosen by the caller: patch/minor/major) with notes; versions are
 *   immutable - promoting the same name again creates the next version
 *
 * Storage is the shared provider (local store by default), collection
 * `frida-modules`. A published module is identified by `name@version`;
 * every version keeps its own script copy, so editing a draft never
 * rewrites what a published version already ran.
 */

const COLLECTION = "frida-modules";

function store() {
  return getStorage() ?? localStorageProvider();
}

export type ModuleStatus = "draft" | "published";

export interface FridaModule {
  id: string;
  name: string;
  version?: string; // set once published; drafts are versionless
  status: ModuleStatus;
  script: string;
  notes?: string;
  /** Semver bump requested at promotion: the first published version is 1.0.0. */
  bump?: "patch" | "minor" | "major";
  /** Provenance: trace tasks that ran this script (id + when + target). */
  testRuns: { taskId: string; at: string; target?: string }[];
  createdAt: string;
  updatedAt: string;
}

const semverOf = (version: string) => version.split(".").map(Number);

function nextVersion(current: string | undefined, bump: "patch" | "minor" | "major"): string {
  if (!current) return "1.0.0";
  const [major, minor, patch] = semverOf(current);
  if (bump === "major") return `${major + 1}.0.0`;
  if (bump === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

const MODULE_NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;

/** Creates or updates the draft for a name. Publishing freezes it; drafts stay editable. */
export async function saveDraft(input: {
  name: string;
  script: string;
  notes?: string;
}): Promise<FridaModule> {
  if (!MODULE_NAME_RE.test(input.name)) {
    throw new Error(
      `"name" must be lowercase letters/digits/hyphens, 3-64 chars, starting with a letter`,
    );
  }
  if (!input.script.trim()) throw new Error(`"script" must not be empty`);

  const now = new Date().toISOString();
  const existing = (await store().findRecord<FridaModule>(
    COLLECTION,
    (m) => m.name === input.name && m.status === "draft",
  )) as FridaModule | null;

  if (existing) {
    const updated: FridaModule = {
      ...existing,
      script: input.script,
      notes: input.notes ?? existing.notes,
      updatedAt: now,
    };
    await store().upsertRecord(COLLECTION, updated);
    return updated;
  }

  const draft: FridaModule = {
    id: `frida-module-${crypto.randomUUID()}`,
    name: input.name,
    status: "draft",
    script: input.script,
    notes: input.notes,
    testRuns: [],
    createdAt: now,
    updatedAt: now,
  };
  await store().upsertRecord(COLLECTION, draft);
  return draft;
}

/** Records that a trace task ran this module's script - the "tested" side of draft -> tested -> published. */
export async function recordTestRun(
  name: string,
  run: { taskId: string; target?: string },
): Promise<FridaModule> {
  const draft = (await store().findRecord<FridaModule>(
    COLLECTION,
    (m) => m.name === name && m.status === "draft",
  )) as FridaModule | null;
  if (!draft) throw new Error(`No draft module named "${name}" - save one with saveDraft first`);
  draft.testRuns.push({ taskId: run.taskId, at: new Date().toISOString(), target: run.target });
  draft.updatedAt = new Date().toISOString();
  await store().upsertRecord(COLLECTION, draft);
  return draft;
}

/**
 * Publishes a draft as an immutable version. The draft stays in the store
 * (cleared of runs) so it can keep being edited for the next version;
 * `bump` defaults to patch. Editing the draft never touches what a
 * published version already ran.
 */
export async function promote(
  name: string,
  bump: "patch" | "minor" | "major" = "patch",
  notes?: string,
): Promise<FridaModule> {
  const draft = (await store().findRecord<FridaModule>(
    COLLECTION,
    (m) => m.name === name && m.status === "draft",
  )) as FridaModule | null;
  if (!draft) throw new Error(`No draft module named "${name}"`);

  const latestPublished = (await store().findRecord<FridaModule>(
    COLLECTION,
    (m) => m.name === name && m.status === "published",
  )) as FridaModule | null;
  const version = nextVersion(latestPublished?.version, bump);

  const published: FridaModule = {
    ...draft,
    id: `frida-module-${crypto.randomUUID()}`,
    status: "published",
    version,
    bump,
    notes: notes ?? draft.notes,
    updatedAt: new Date().toISOString(),
  };
  await store().upsertRecord(COLLECTION, published);

  // the draft lives on for the next iteration, with a clean run history
  draft.testRuns = [];
  draft.updatedAt = new Date().toISOString();
  await store().upsertRecord(COLLECTION, draft);

  return published;
}

export async function getModule(name: string, version?: string): Promise<FridaModule | null> {
  const all = (await store().listRecords<FridaModule>(COLLECTION)).filter((m) => m.name === name);
  if (version) return all.find((m) => m.version === version) ?? null;
  // no version: the latest published wins, falling back to the draft
  const published = all
    .filter((m) => m.status === "published")
    .sort((a, b) => semverCompare(b.version!, a.version!));
  return published[0] ?? all.find((m) => m.status === "draft") ?? null;
}

/** Semver-aware comparison for three-component version strings. */
function semverCompare(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

export async function listModules(): Promise<FridaModule[]> {
  return (await store().listRecords<FridaModule>(COLLECTION)).sort(
    (a, b) => a.name.localeCompare(b.name) || (b.version ?? "").localeCompare(a.version ?? ""),
  );
}

/** Resolves a module reference - "name" (latest version or draft) or "name@1.2.0" - to its script. */
export async function resolveScript(ref: string): Promise<{ script: string; module: FridaModule }> {
  const at = ref.lastIndexOf("@");
  const name = at > 0 ? ref.slice(0, at) : ref;
  const version = at > 0 ? ref.slice(at + 1) : undefined;
  const module = await getModule(name, version);
  if (!module) {
    throw new Error(
      version
        ? `No module "${name}@${version}" in the store`
        : `No module "${name}" in the store - save a draft with saveDraft first`,
    );
  }
  return { script: module.script, module };
}
