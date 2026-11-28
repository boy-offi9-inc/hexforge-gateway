import { Pool } from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config, isSupabaseConfigured } from "../core/config.js";
import * as localStore from "./local-storage.provider.js";
import { getSupabase } from "./supabase.client.js";

/**
 * One storage contract for every backend, so a service never branches on
 * which one is active. A `collection` is a table for the database-backed
 * providers and a JSON file for the local one, whose function shape this
 * interface mirrors - local storage has always been the fallback contract
 * (see providers/local-storage.provider.ts).
 *
 * Both database providers fall back to the local provider per call when a
 * query fails, which is what services used to implement inline: an
 * unreachable database degrades to local persistence instead of failing the
 * request, and the two tiers are never reconciled (see docs/SETUP.md,
 * "Storage").
 */
export interface StorageProvider {
  upsertRecord<T extends { id: string }>(collection: string, record: T): Promise<T>;
  upsertRecords<T extends { id: string }>(collection: string, records: T[]): Promise<T[]>;
  getRecord<T>(collection: string, id: string): Promise<T | null>;
  findRecord<T>(collection: string, predicate: (record: T) => boolean): Promise<T | null>;
  listRecords<T>(collection: string): Promise<T[]>;
  deleteRecord(collection: string, id: string): Promise<boolean>;
}

function warnFallback(source: string, op: string, message: string) {
  console.warn(`[storage:${source}] ${op} failed, falling back to local storage: ${message}`);
  markStorageDegraded();
}

// Set the first time a remote-backend call degrades to local storage, so
// /health can surface it (degraded: true) - fallback writes are never
// replayed to the remote backend, so an operator must be able to SEE the
// split-brain state instead of discovering it in a diff. Never cleared
// automatically: recovery needs a human decision (reconciliation/export),
// so the flag stays until the process restarts with a working backend.
let degraded = false;
export function markStorageDegraded() {
  degraded = true;
}
export function isStorageDegraded(): boolean {
  return degraded;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class LocalStorageProvider implements StorageProvider {
  upsertRecord<T extends { id: string }>(collection: string, record: T): Promise<T> {
    return localStore.upsertRecord(collection, record);
  }
  upsertRecords<T extends { id: string }>(collection: string, records: T[]): Promise<T[]> {
    return localStore.upsertRecords(collection, records);
  }
  getRecord<T>(collection: string, id: string): Promise<T | null> {
    return localStore.getRecord<T>(collection, id);
  }
  findRecord<T>(collection: string, predicate: (record: T) => boolean): Promise<T | null> {
    return localStore.findRecord<T>(collection, predicate);
  }
  listRecords<T>(collection: string): Promise<T[]> {
    return localStore.listRecords<T>(collection);
  }
  deleteRecord(collection: string, id: string): Promise<boolean> {
    return localStore.deleteRecord(collection, id);
  }
}

/**
 * Supabase keeps its column-per-field tables (supabase.schema.sql), so a
 * record is a row rather than one jsonb blob - a schema created before this
 * layer existed keeps working unchanged.
 */
export class SupabaseProvider implements StorageProvider {
  constructor(private readonly client: SupabaseClient) {}

  async upsertRecord<T extends { id: string }>(collection: string, record: T): Promise<T> {
    const { error } = await this.client.from(collection).upsert(record);
    if (error) {
      warnFallback("supabase", "upsert", error.message);
      return localStore.upsertRecord(collection, record);
    }
    return record;
  }

  async upsertRecords<T extends { id: string }>(collection: string, records: T[]): Promise<T[]> {
    if (records.length === 0) return records;
    const { error } = await this.client.from(collection).upsert(records);
    if (error) {
      warnFallback("supabase", "upsert", error.message);
      return localStore.upsertRecords(collection, records);
    }
    return records;
  }

  async getRecord<T>(collection: string, id: string): Promise<T | null> {
    const { data, error } = await this.client
      .from(collection)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      warnFallback("supabase", "select", error.message);
      return localStore.getRecord<T>(collection, id);
    }
    return (data as T | null) ?? null;
  }

  async findRecord<T>(collection: string, predicate: (record: T) => boolean): Promise<T | null> {
    const all = await this.listRecords<T>(collection);
    return all.find(predicate) ?? null;
  }

  async listRecords<T>(collection: string): Promise<T[]> {
    const { data, error } = await this.client.from(collection).select("*");
    if (error) {
      warnFallback("supabase", "select", error.message);
      return localStore.listRecords<T>(collection);
    }
    return data as T[];
  }

  async deleteRecord(collection: string, id: string): Promise<boolean> {
    const { error, count } = await this.client
      .from(collection)
      .delete({ count: "exact" })
      .eq("id", id);
    if (error) {
      warnFallback("supabase", "delete", error.message);
      return localStore.deleteRecord(collection, id);
    }
    return (count ?? 0) > 0;
  }
}

const COLLECTION_NAME = /^[a-z][a-z0-9_]*$/;

/** Collection names reach SQL, so they're allowlisted rather than escaped - none are user-supplied today. */
function tableName(collection: string): string {
  if (!COLLECTION_NAME.test(collection)) {
    throw new Error(`Invalid storage collection name: ${JSON.stringify(collection)}`);
  }
  return `"${collection}"`;
}

interface Row {
  data: unknown;
}

/**
 * Postgres (Neon or any DATABASE_URL) with the same collection semantics as
 * the local provider: one table per collection, `id text primary key` and
 * the whole record in a `data jsonb` column. See postgres.schema.sql - the
 * one thing the local provider never needed is creating the tables.
 */
export class PostgresProvider implements StorageProvider {
  private readonly pool: Pool;

  constructor(connectionString: string, pool?: Pool) {
    this.pool = pool ?? new Pool({ connectionString, max: 5 });
  }

  async upsertRecord<T extends { id: string }>(collection: string, record: T): Promise<T> {
    const sql = `insert into ${tableName(collection)} (id, data) values ($1, $2)
      on conflict (id) do update set data = excluded.data`;
    try {
      await this.pool.query(sql, [record.id, JSON.stringify(record)]);
      return record;
    } catch (err) {
      warnFallback("postgres", `upsert ${collection}`, errorMessage(err));
      return localStore.upsertRecord(collection, record);
    }
  }

  async upsertRecords<T extends { id: string }>(collection: string, records: T[]): Promise<T[]> {
    if (records.length === 0) return records;
    const sql = `insert into ${tableName(collection)} (id, data) values ($1, $2)
      on conflict (id) do update set data = excluded.data`;
    try {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        for (const record of records) {
          await client.query(sql, [record.id, JSON.stringify(record)]);
        }
        await client.query("commit");
      } catch (err) {
        await client.query("rollback").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      return records;
    } catch (err) {
      warnFallback("postgres", `upsert ${collection}`, errorMessage(err));
      return localStore.upsertRecords(collection, records);
    }
  }

  async getRecord<T>(collection: string, id: string): Promise<T | null> {
    const rows = await this.run<T>(
      collection,
      "select",
      `select data from ${tableName(collection)} where id = $1`,
      [id],
      async () => {
        const local = await localStore.getRecord<T>(collection, id);
        return local === null ? [] : [local];
      },
    );
    return rows[0] ?? null;
  }

  async findRecord<T>(collection: string, predicate: (record: T) => boolean): Promise<T | null> {
    const all = await this.listRecords<T>(collection);
    return all.find(predicate) ?? null;
  }

  async listRecords<T>(collection: string): Promise<T[]> {
    return this.run<T>(collection, "select", `select data from ${tableName(collection)}`, [], () =>
      localStore.listRecords<T>(collection),
    );
  }

  async deleteRecord(collection: string, id: string): Promise<boolean> {
    try {
      const result = await this.pool.query(`delete from ${tableName(collection)} where id = $1`, [
        id,
      ]);
      return (result.rowCount ?? 0) > 0;
    } catch (err) {
      warnFallback("postgres", `delete ${collection}`, errorMessage(err));
      return localStore.deleteRecord(collection, id);
    }
  }

  /** Runs one query and maps its rows, falling back to `fallback` if it fails. */
  private async run<T>(
    collection: string,
    op: string,
    sql: string,
    params: unknown[],
    fallback: () => T[] | Promise<T[]>,
  ): Promise<T[]> {
    try {
      const result = await this.pool.query<Row>(sql, params);
      return result.rows.map((row) => row.data as T);
    } catch (err) {
      warnFallback("postgres", `${op} ${collection}`, errorMessage(err));
      return fallback();
    }
  }
}

let localProvider: LocalStorageProvider | null = null;
let supabaseProvider: SupabaseProvider | null = null;
let postgresProvider: PostgresProvider | null = null;

/**
 * The provider for the configured STORAGE_BACKEND, or null when that's
 * "local" - services read null as "use localStorageProvider()", which is the
 * shape they already had with getSupabase() === null. "postgres" also needs
 * DATABASE_URL; without it the boot fails in core/config.ts.
 */
export function getStorage(): StorageProvider | null {
  if (config.STORAGE_BACKEND === "postgres") {
    if (!postgresProvider) postgresProvider = new PostgresProvider(config.DATABASE_URL!);
    return postgresProvider;
  }
  if (config.STORAGE_BACKEND === "supabase" && isSupabaseConfigured) {
    const client = getSupabase();
    if (!client) return null;
    if (!supabaseProvider) supabaseProvider = new SupabaseProvider(client);
    return supabaseProvider;
  }
  return null;
}

export function localStorageProvider(): StorageProvider {
  if (!localProvider) localProvider = new LocalStorageProvider();
  return localProvider;
}
