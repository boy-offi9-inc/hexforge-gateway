import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// local-storage.provider.ts reads DATA_DIR from src/core/config.ts once at
// import time, and keeps an in-memory collectionCache keyed by collection
// name for the lifetime of that module instance. To get a clean slate per
// test - a fresh on-disk directory *and* a fresh cache - we point DATA_DIR
// at a new temp dir and vi.resetModules() before every dynamic import
// below, rather than importing the module once at the top of the file.
type LocalStorageModule = typeof import("../src/providers/local-storage.provider.js");

interface Widget {
  id: string;
  name: string;
  tag?: string;
}

let dataDir: string;
let store: LocalStorageModule;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-local-storage-"));
  vi.resetModules();
  vi.stubEnv("DATA_DIR", dataDir);
  store = await import("../src/providers/local-storage.provider.js");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dataDir, { recursive: true, force: true });
});

describe("local-storage.provider", () => {
  it("returns null for a record whose collection file doesn't exist yet", async () => {
    await expect(store.getRecord<Widget>("widgets", "missing")).resolves.toBeNull();
  });

  it("round-trips a record through upsert / get / list", async () => {
    const record: Widget = { id: "a1", name: "First" };
    await store.upsertRecord("widgets", record);

    await expect(store.getRecord<Widget>("widgets", "a1")).resolves.toEqual(record);
    await expect(store.listRecords<Widget>("widgets")).resolves.toEqual([record]);
  });

  it("upserting the same id again overwrites rather than duplicating", async () => {
    await store.upsertRecord<Widget>("widgets", { id: "a1", name: "First" });
    await store.upsertRecord<Widget>("widgets", { id: "a1", name: "Renamed" });

    const all = await store.listRecords<Widget>("widgets");
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual({ id: "a1", name: "Renamed" });
  });

  it("writes a real JSON file to disk that a fresh module instance (cold cache) can read back", async () => {
    await store.upsertRecord<Widget>("widgets", { id: "a1", name: "First" });

    const raw = await readFile(path.join(dataDir, "widgets.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual({ a1: { id: "a1", name: "First" } });

    // Re-import with a reset module registry so this read can't be served
    // from the in-memory collectionCache - it has to come from disk.
    vi.resetModules();
    vi.stubEnv("DATA_DIR", dataDir);
    const reopened: LocalStorageModule = await import("../src/providers/local-storage.provider.js");
    await expect(reopened.getRecord<Widget>("widgets", "a1")).resolves.toEqual({ id: "a1", name: "First" });
  });

  it("deleteRecord removes an existing record and reports true", async () => {
    await store.upsertRecord<Widget>("widgets", { id: "a1", name: "First" });

    await expect(store.deleteRecord("widgets", "a1")).resolves.toBe(true);
    await expect(store.getRecord<Widget>("widgets", "a1")).resolves.toBeNull();
  });

  it("deleteRecord reports false for an id that was never there, without throwing", async () => {
    await expect(store.deleteRecord("widgets", "ghost")).resolves.toBe(false);
  });

  it("findRecord returns the first match, or null when nothing matches", async () => {
    await store.upsertRecord<Widget>("widgets", { id: "a1", name: "First", tag: "x" });
    await store.upsertRecord<Widget>("widgets", { id: "a2", name: "Second", tag: "y" });

    await expect(store.findRecord<Widget>("widgets", (r) => r.tag === "y")).resolves.toEqual({
      id: "a2",
      name: "Second",
      tag: "y",
    });
    await expect(store.findRecord<Widget>("widgets", (r) => r.tag === "z")).resolves.toBeNull();
  });

  it("keeps separate collections independent, even with overlapping ids", async () => {
    await store.upsertRecord<Widget>("widgets", { id: "a1", name: "A Widget" });
    await store.upsertRecord<Widget>("gadgets", { id: "a1", name: "A Gadget" });

    await expect(store.getRecord<Widget>("widgets", "a1")).resolves.toEqual({ id: "a1", name: "A Widget" });
    await expect(store.getRecord<Widget>("gadgets", "a1")).resolves.toEqual({ id: "a1", name: "A Gadget" });
  });

  it("serializes concurrent upserts to one collection instead of one clobbering another", async () => {
    // Regression test for the race the module's own comment calls out:
    // N concurrent read-modify-write cycles on the same collection should
    // all survive - not just whichever happens to write to disk last.
    const count = 20;
    await Promise.all(
      Array.from({ length: count }, (_, i) => store.upsertRecord<Widget>("widgets", { id: `r${i}`, name: `Record ${i}` }))
    );

    const all = await store.listRecords<Widget>("widgets");
    expect(all).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(all.find((r) => r.id === `r${i}`)).toEqual({ id: `r${i}`, name: `Record ${i}` });
    }
  });

  it("survives an upsert and a delete racing on the same collection", async () => {
    await store.upsertRecord<Widget>("widgets", { id: "keep", name: "Keeper" });

    await Promise.all([
      store.upsertRecord<Widget>("widgets", { id: "new", name: "Newcomer" }),
      store.deleteRecord("widgets", "keep"),
    ]);

    const all = await store.listRecords<Widget>("widgets");
    expect(all.find((r) => r.id === "new")).toEqual({ id: "new", name: "Newcomer" });
    expect(all.find((r) => r.id === "keep")).toBeUndefined();
  });
});
