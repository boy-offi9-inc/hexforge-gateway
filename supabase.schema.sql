-- HexForge Gateway - Supabase schema starter
-- Run this in the Supabase SQL editor once you're ready to move off in-memory storage.

create table if not exists workspaces (
  id text primary key,
  name text not null,
  "targetLabel" text not null,
  status text not null default 'created',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- Used by PUT /workspaces/by-name/:name (getOrCreateWorkspace). Not a
-- unique index - two concurrent get-or-create calls for a brand-new name
-- could each create one, since there's no DB-level uniqueness constraint
-- backing this yet. Fine for the dev-convenience use case this serves;
-- add a unique constraint + upsert if this ever needs to be race-safe.
create index if not exists workspaces_name_idx on workspaces(name);

create table if not exists tasks (
  id text primary key,
  "workspaceId" text not null references workspaces(id) on delete cascade,
  agent text not null,
  operation text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued',
  result jsonb,
  error text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists tasks_workspace_id_idx on tasks("workspaceId");

create table if not exists knowledge_entries (
  id text primary key,
  "workspaceId" text not null references workspaces(id) on delete cascade,
  type text not null,
  title text not null,
  content text not null,
  source text not null default 'user',
  "sourceId" text,
  "relatedEntryIds" jsonb not null default '[]',
  embedding jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists knowledge_entries_workspace_id_idx on knowledge_entries("workspaceId");
create index if not exists knowledge_entries_type_idx on knowledge_entries(type);

create table if not exists jobs (
  id text primary key,
  "workspaceId" text not null references workspaces(id) on delete cascade,
  agent text not null,
  operation text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued',
  attempts integer not null default 0,
  "maxAttempts" integer not null default 1,
  "currentTaskId" text,
  result jsonb,
  error text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists jobs_workspace_id_idx on jobs("workspaceId");

create table if not exists workflows (
  id text primary key,
  "workspaceId" text not null references workspaces(id) on delete cascade,
  name text not null,
  status text not null default 'queued',
  "currentStepIndex" integer not null default 0,
  steps jsonb not null default '[]',
  error text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index if not exists workflows_workspace_id_idx on workflows("workspaceId");

-- Note: the underlying McpTasks that back each Job attempt are still
-- in-memory only (see modules/mcp/orchestrator.ts) - only the Job/Workflow
-- snapshots above persist. A Job left "running"/"queued" when the process
-- restarts has no Task to resume, so JobEngine.hydrate() / WorkflowEngine
-- .hydrate() mark those "failed" rather than resuming them.
