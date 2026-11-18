import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// LocalStorageProvider wraps providers/local-storage.provider.ts, which
// resolves DATA_DIR once at import time - so each test gets a throwaway
// directory and a fresh module graph, same approach as
// local-storage.provider.test.ts.

type StorageModule = typeof import("../src/providers/storage.provider.js");

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "hexforge-storage-provider-"));
  vi.resetModules();
  vi.stubEnv("DATA_DIR", dataDir);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await rm(dataDir, { recursive: true, force: true });
});

async function loadStorage(): Promise<StorageModule> {
  return import("../src/providers/storage.provider.js");
}

interface Rec {
  id: string;
  name: string;
  count: number;
}

/** Every StorageProvider must satisfy this, whichever backend implements it. */
async function expectStorageContract(
  provider: StorageModule["StorageProvider"] extends never
    ? never
    : import("../src/providers/storage.provider.js").StorageProvider,
): Promise<void> {
  await provider.upsertRecord<Rec>("conformance", { id: "a", name: "alpha", count: 1 });
  await provider.upsertRecord<Rec>("conformance", { id: "b", name: "beta", count: 2 });

  expect(await provider.getRecord<Rec>("conformance", "a")).toEqual({
    id: "a",
    name: "alpha",
    count: 1,
  });
  expect(await provider.getRecord<Rec>("conformance", "missing")).toBeNull();

  expect((await provider.listRecords<Rec>("conformance")).map((r) => r.id).sort()).toEqual([
    "a",
    "b",
  ]);
  expect(await provider.listRecords<Rec>("empty_collection")).toEqual([]);

  expect(await provider.findRecord<Rec>("conformance", (r) => r.name === "beta")).toEqual({
    id: "b",
    name: "beta",
    count: 2,
  });
  expect(await provider.findRecord<Rec>("conformance", (r) => r.name === "nope")).toBeNull();

  // Upsert on an existing id replaces the record rather than duplicating it.
  await provider.upsertRecord<Rec>("conformance", { id: "a", name: "alpha2", count: 9 });
  expect(await provider.getRecord<Rec>("conformance", "a")).toEqual({
    id: "a",
    name: "alpha2",
    count: 9,
  });
  expect(await provider.listRecords<Rec>("conformance")).toHaveLength(2);

  await provider.upsertRecords<Rec>("batch", [
    { id: "x", name: "ex", count: 1 },
    { id: "y", name: "why", count: 2 },
  ]);
  expect((await provider.listRecords<Rec>("batch")).map((r) => r.id).sort()).toEqual(["x", "y"]);
  expect(await provider.upsertRecords("batch", [])).toEqual([]);

  expect(await provider.deleteRecord("conformance", "a")).toBe(true);
  expect(await provider.deleteRecord("conformance", "a")).toBe(false);
  expect(await provider.getRecord("conformance", "a")).toBeNull();
}

describe("storage.provider - LocalStorageProvider", () => {
  it("satisfies the StorageProvider contract", async () => {
    const { LocalStorageProvider } = await loadStorage();
    await expectStorageContract(new LocalStorageProvider());
  });

  it("persists across a fresh module graph (real files, not memory)", async () => {
    const first = await loadStorage();
    await new first.LocalStorageProvider().upsertRecord("persisted", {
      id: "r1",
      name: "one",
      count: 1,
    });

    vi.resetModules();
    const second = await loadStorage();
    expect(await new second.LocalStorageProvider().getRecord("persisted", "r1")).toEqual({
      id: "r1",
      name: "one",
      count: 1,
    });
  });

  it("getStorage() returns null for STORAGE_BACKEND=local, so services use the local provider", async () => {
    vi.stubEnv("STORAGE_BACKEND", "local");
    const { getStorage, localStorageProvider } = await loadStorage();
    expect(getStorage()).toBeNull();
    expect(localStorageProvider()).toBeInstanceOf(Object);
  });
});

// A pg Pool double: records every query and lets a test make one fail, which
// is how PostgresProvider is exercised without a live database.
class FakePool {
  queries: Array<{ text: string; values?: unknown[] }> = [];
  failOn: RegExp | null = null;
  released = 0;
  tables = new Map<string, Array<{ id: string; data: unknown }>>();

  private tableOf(text: string): Array<{ id: string; data: unknown }> {
    const match = text.match(/(?:into|from)\s+"?([a-z_]+)"?/i);
    const name = match?.[1] ?? "unknown";
    if (!this.tables.has(name)) this.tables.set(name, []);
    return this.tables.get(name)!;
  }

  private respond(text: string, values?: unknown[]) {
    if (this.failOn?.test(text)) throw new Error("connection refused");
    const rows = this.tableOf(text);
    if (/^select .* where id = \$1/i.test(text.trim())) {
      const hit = rows.find((r) => r.id === values?.[0]);
      return { rows: hit ? [{ data: hit.data }] : [], rowCount: hit ? 1 : 0 };
    }
    if (/^select /i.test(text.trim())) {
      return { rows: rows.map((r) => ({ data: r.data })), rowCount: rows.length };
    }
    if (/^insert into/i.test(text.trim())) {
      const id = values?.[0] as string;
      const data = JSON.parse(values?.[1] as string);
      const existing = rows.find((r) => r.id === id);
      if (existing) existing.data = data;
      else rows.push({ id, data });
      return { rows: [], rowCount: 1 };
    }
    if (/^delete from/i.test(text.trim())) {
      const before = rows.length;
      const kept = rows.filter((r) => r.id !== values?.[0]);
      rows.length = 0;
      rows.push(...kept);
      return { rows: [], rowCount: before - rows.length };
    }
    return { rows: [], rowCount: 0 };
  }

  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, values });
    return this.respond(text, values);
  }

  async connect() {
    return {
      query: (text: string, values?: unknown[]) => this.query(text, values),
      release: () => {
        this.released++;
      },
    };
  }
}

describe("storage.provider - PostgresProvider", () => {
  it("satisfies the StorageProvider contract against a pool double", async () => {
    const { PostgresProvider } = await loadStorage();
    const pool = new FakePool();
    const provider = new PostgresProvider("postgres://unused", pool as never);
    await expectStorageContract(provider);
  });

  it("reads and writes the id + data jsonb shape with parameterized ids", async () => {
    const { PostgresProvider } = await loadStorage();
    const pool = new FakePool();
    const provider = new PostgresProvider("postgres://unused", pool as never);

    await provider.upsertRecord("workspaces", { id: "w1", name: "demo" });
    expect(await provider.getRecord("workspaces", "w1")).toEqual({ id: "w1", name: "demo" });

    const insert = pool.queries.find((q) => /^insert into/i.test(q.text.trim()));
    expect(insert?.text).toContain('"workspaces"');
    expect(insert?.text).toContain("on conflict (id) do update set data = excluded.data");
    expect(insert?.values?.[0]).toBe("w1");
    expect(JSON.parse(insert?.values?.[1] as string)).toEqual({ id: "w1", name: "demo" });

    const select = pool.queries.find((q) => /^select data from/i.test(q.text.trim()));
    expect(select?.values).toEqual(["w1"]);
  });

  it("falls back to the local provider when a query fails", async () => {
    const { PostgresProvider } = await loadStorage();
    const pool = new FakePool();
    const provider = new PostgresProvider("postgres://unused", pool as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      pool.failOn = /insert|select/i;
      // A write that never reached Postgres is stored locally instead.
      await provider.upsertRecord("offline", { id: "o1", name: "kept" });
      expect(await provider.getRecord("offline", "o1")).toEqual({ id: "o1", name: "kept" });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("[storage:postgres] select offline failed"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back on a failed delete too", async () => {
    const { PostgresProvider } = await loadStorage();
    const pool = new FakePool();
    const provider = new PostgresProvider("postgres://unused", pool as never);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      pool.failOn = /insert/i;
      await provider.upsertRecord("offline", { id: "o1" });
      pool.failOn = /delete/i;
      // The failed insert fell back to local storage, so the delete is served there.
      expect(await provider.deleteRecord("offline", "o1")).toBe(true);
      expect(await provider.deleteRecord("offline", "o1")).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("rejects a collection name that could not be a table", async () => {
    const { PostgresProvider } = await loadStorage();
    const provider = new PostgresProvider("postgres://unused", new FakePool() as never);
    await expect(provider.listRecords('bad"name')).rejects.toThrow(
      /Invalid storage collection name/,
    );
  });
});
