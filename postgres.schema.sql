-- HexForge Gateway - Postgres schema (STORAGE_BACKEND=postgres, Neon or any DATABASE_URL)
-- Unlike Supabase's column-per-field tables (supabase.schema.sql), every
-- collection is one table with the record stored whole in a `data` jsonb
-- column - the shape providers/storage.provider.ts reads and writes.
-- Run once against the target database before starting the Gateway.

create table if not exists workspaces (
  id text primary key,
  data jsonb not null
);

create table if not exists knowledge_entries (
  id text primary key,
  data jsonb not null
);

create table if not exists jobs (
  id text primary key,
  data jsonb not null
);

create table if not exists workflows (
  id text primary key,
  data jsonb not null
);

-- Indexer-only collections (used by upsertRecords); created lazily by the
-- same one-table-per-collection shape if more appear.
create table if not exists graph_entities (
  id text primary key,
  data jsonb not null
);

create table if not exists graph_edges (
  id text primary key,
  data jsonb not null
);

create table if not exists artifacts (
  id text primary key,
  data jsonb not null
);

create table if not exists findings (
  id text primary key,
  data jsonb not null
);
