# Setup

Device requirements, Auth, Storage backend choice, and platform-specific
(PC/Android) setup - everything needed to get a working Gateway running
and configured, as opposed to how any given feature works internally.

## Device requirements

Minimums, not comfort levels - the Gateway itself is a lightweight Node
process, but jadx/apktool are JVM tools that can get memory- and
CPU-hungry on large or heavily obfuscated APKs.

**Software (either platform):**
- Node.js 22+
- `jadx` and `apktool` on `PATH` if you'll use those agents (both need a JVM - `openjdk-17` or similar)
- `adb` on `PATH` for the `adb` agent (Android platform-tools)
- `frida-tools` (`pip install frida-tools`, needs Python) plus a matching `frida-server` on the target device for the `frida` agent - the version match between the two is the most common Frida failure
- `apkid` (`pip install apkid`, needs a yara-python build with DEX support) for the `apkid` agent
- Nothing extra for the `hf` CLI (it's Node). `curl` + `jq` only for `scripts/smoke-test.sh`

**RAM:** No hard minimum for the Gateway process alone - it's small. The
real constraint is jadx/apktool decompiling a specific APK: small/simple
apps are fine on modest hardware, large or obfuscated ones need
noticeably more heap and time. Rarely a problem on a PC. On Android via
Termux, a device with less than ~4GB total RAM will likely struggle on
anything beyond small APKs - not a number that can be pinned down
precisely, since it depends entirely on the APK.

**Storage:** The Gateway's own data (`data/*.json`, workspace/knowledge
metadata) stays tiny. The real space usage is `WORKSPACES_ROOT`, where
jadx/apktool output lands - decompiled source can run several times the
original APK's size. Budget per APK you work with, not once for the
whole project.

**Android version (Termux):** Android 7.0+ works with Termux installed
via F-Droid or GitHub releases (the recommended install path - see
"Running on Android" below). The Google Play Store build of Termux is
discouraged and has reduced functionality; that build specifically needs
Android 11+. Check [Termux's own docs](https://github.com/termux/termux-app)
for anything more current, since app store requirements shift over time.

**Network:** None required at all with `STORAGE_BACKEND=local` (the
default) and `AI_PROVIDER=ollama` or `openai-compatible` pointed at a
local server - the Gateway can run fully offline. Network is only needed
for a cloud AI provider, `STORAGE_BACKEND=supabase`/`postgres`, or the
`webhook-notifier` plugin actually sending anything.


## Auth

Off by default. `core/auth.ts` is an opt-in API key check - without it,
every route trusts whoever can reach the port: `adb shell` runs arbitrary
commands on a connected device, `filesystem` can write and delete files,
`apktool`/`jadx` can rebuild and resign APKs. Reasonable for a local,
single-user tool; not once the Gateway is reachable beyond `localhost`.

Turn it on:

```bash
AUTH_ENABLED=true
API_KEYS=some-long-random-key,another-key-for-a-second-device
```

Then send the key as either header on every request:

```bash
curl -H "Authorization: Bearer some-long-random-key" http://localhost:8080/workspaces
# or
curl -H "X-API-Key: some-long-random-key" http://localhost:8080/workspaces
```

`GET /health` is always exempt (so uptime checks work without a key) -
everything else, including `GET /` (which lists workspace names), is
gated once auth is on. Multiple comma-separated keys in `API_KEYS` let
different devices/people use their own, so you can revoke one without
rotating everyone's.

One safety net: `AUTH_ENABLED=true` with an empty `API_KEYS` doesn't lock
you out - it's treated as still-open, with a warning printed at startup,
rather than silently making every route unreachable including to you.
`GET /health`'s `authEnabled` field only reports `true` once a real key
is configured, so you can confirm it's actually active rather than
assuming from the env var alone.

The Gateway also binds `127.0.0.1` by default since v1.16.0 - set `HOST`
only if you deliberately want another interface, and note that a remote
host with auth off refuses to start on bare metal (see
[SAFETY](SAFETY.md#network-exposure)). The Docker image still listens on
`0.0.0.0` inside its namespace; keep the host-side mapping on `127.0.0.1`
(the published compose file already does) unless auth is on.

The CLI wrapper picks this up automatically - set `HEXFORGE_API_KEY` and
every `hf`/`smoke-test.sh` command sends it.

This is deliberately simple: one flat list of shared keys, no per-key
scopes, no expiry, no user accounts. Fine for a single operator's own
devices; if this project grows into something with actual multiple
untrusted users, `core/auth.ts` is the one file to replace, not extend.


## Storage: local (default), Supabase, or Postgres

`STORAGE_BACKEND` picks where `workspaces`, `knowledge_entries`, `jobs`
and `workflows` live:

- **`local`** (the default) — everything goes to
  `providers/local-storage.provider.ts`, a JSON file per collection under
  `DATA_DIR` (default `./data/`). Writes are atomic (temp file + rename)
  so a killed process (common on mobile/Termux) can't corrupt it. No
  Supabase project, no network calls, no setup. `SUPABASE_URL` /
  `SUPABASE_SERVICE_ROLE_KEY` are ignored entirely in this mode, even if
  they're set in `.env`.
- **`supabase`** — Supabase is primary, and a runtime failure (offline,
  DNS failure, outage) falls back to the same local file store
  automatically instead of crashing the request. Switch to this once
  there's an actual reason to share state across devices/users - e.g.
  once a web interface exists.
- **`postgres`** — any Postgres reachable over a connection string,
  **Neon** included. Same fallback behavior as Supabase: a failed query is
  served from local storage and logged, so a database outage degrades
  instead of failing the request.

To use Supabase: create a project, run `supabase.schema.sql` in the SQL
editor, then set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`STORAGE_BACKEND=supabase` in `.env`. `GET /health`'s `storageBackend`
field confirms which mode is actually active, and `degraded: true` means
the backend failed at least once and writes are landing in local storage
instead - fallback writes are NOT replayed to the remote backend on
recovery, so reconcile manually before treating the database as the
source of truth again.

To use Postgres: run `postgres.schema.sql` against the database once (one
table per collection, `id text primary key` plus the record in a `data
jsonb` column), then set `DATABASE_URL` (Neon's pooled connection string
works as-is - remember `?sslmode=require` if your provider needs it) and
`STORAGE_BACKEND=postgres`. `DATABASE_URL` without `STORAGE_BACKEND=postgres`
does nothing, and `STORAGE_BACKEND=postgres` without `DATABASE_URL` fails
at startup rather than on the first request.

All three backends sit behind `providers/storage.provider.ts`, a single
interface (`upsertRecord`, `upsertRecords`, `getRecord`, `findRecord`,
`listRecords`, `deleteRecord`) with one implementation per backend, so a
service never branches on which one is active and adding a backend is one
class rather than edits across every service.

Worth knowing on any of them:

- **No sync between the tiers.** Anything written to local storage while
  on `supabase`/`postgres` mode during an outage stays local-only - check
  `data/*.json` for anything written during the gap if that matters.
  Switching `local` → `supabase`/`postgres` later doesn't auto-migrate
  existing local data either.
- **Local mode is not a real database.** No indexing, no migrations, no
  query language - a flat `{ id: record }` JSON map per collection. Concurrent writes
  *within one process* are safe (`upsertRecord`/`deleteRecord` serialize
  per collection so two requests racing on the same collection can't
  silently drop one's write) but that doesn't extend across multiple
  processes sharing one `DATA_DIR`, which isn't a supported setup.
- **Jobs and Workflows persist like everything else** (local files, or
  database write-through with local fallback), but the McpTasks behind
  each Job attempt are in-memory only. A job or workflow still
  `running`/`queued` when the Gateway restarts is marked `failed` on
  startup rather than resumed.

Falling back is logged (`[storage:postgres] select workspaces failed,
falling back to local storage: ...`), so it's visible rather than silent.

### Neon (Postgres) hosting guide, step by step

The free Neon tier is enough for HexForge's single-operator data volumes
(workspaces, knowledge entries, jobs and workflows are small records).

1. **Create the project.** Sign up at neon.tech, create a project (any
   name; a HexForge workspace is a *record*, not a Neon project), and
   pick the Postgres version it offers by default. Note the region - the
   Gateway talks to it on every request, so pick the one closest to
   wherever the Gateway runs (a Termux phone, a VPS, a PC).

2. **Copy the pooled connection string.** Neon's dashboard shows a
   connection string per branch. Use the one with `-pooler` in the host
   (Neon's pgBouncer pooled endpoint) - HexForge's pool is small
   (`max: 5` in `providers/storage.provider.ts`), and the pooled endpoint
   is what the free tier is sized for. It looks like:

   ```
   postgresql://user:password@ep-xyz-pooler.region.aws.neon.tech/neondb
   ```

   Neon's strings already carry `?sslmode=require`. Keep it - the
   credentials travel over the network.

3. **Apply the schema, once.** With `psql` (or Neon's SQL editor, which
   accepts the same statements):

   ```bash
   psql "postgresql://...neon.tech/neondb?sslmode=require" -f postgres.schema.sql
   ```

   It's all `create table if not exists`, so running it twice is harmless.

4. **Point the Gateway at it.** In `.env` next to the Gateway:

   ```bash
   DATABASE_URL=postgresql://user:password@ep-xyz-pooler.region.aws.neon.tech/neondb?sslmode=require
   STORAGE_BACKEND=postgres
   ```

   `DATABASE_URL` without `STORAGE_BACKEND=postgres` does nothing, and
   the reverse fails at startup - both mistakes fail loudly on purpose
   (see the storage section above).

5. **Boot and verify.** Start the Gateway (`npm run dev`), then:

   ```bash
   curl -s http://localhost:8080/health | grep storage
   # "storageBackend":"postgres" - the live boot check
   ```

   A `storageBackend` still reporting `local` means the backend didn't
   switch (check `.env` was read - the startup banner prints both
   settings). If Neon is unreachable at boot the Gateway still starts:
   queries fall back to local storage with a logged
   `[storage:postgres] ... falling back to local storage` line, so the
   failure mode is visible in the logs, not silent.

6. **Create a workspace and check it landed in Neon:**

   ```bash
   curl -X PUT http://localhost:8080/workspaces/by-name/neon-test      -H "Content-Type: application/json" -d '{}'
   ```
   then in Neon's SQL editor: `select id, data from workspaces;` should
   show the row. Delete it from the UI or with a `DELETE` when done.

Two things worth knowing before relying on it: writes fall back to
**local** storage during a Neon outage and are *not* replayed when Neon
returns (check `data/*.json` for the gap, per the storage section); and
Neon's free tier autosuspends after inactivity - the first request after
a suspension pays a cold-start of a second or so, which is visible as a
slow first job after an idle period and nothing else.


## Console output

On an interactive terminal the Gateway prints a startup box (every address it's
reachable on, storage, AI provider, auth, plugins, inbox, workspaces),
warnings that matter, and one readable line per request:

```
╭─ ⬢ HexForge Gateway v1.3.7 ────────────────╮
│ listening  http://127.0.0.1:8080 local     │
│            http://10.245.38.1:8080         │
│ auth       OPEN                            │
╰────────────────────────────────────────────╯

 ▲ Auth is off and this port is reachable from your network - anyone on it
   has full access. Set AUTH_ENABLED=true and API_KEYS in .env.

 GET    /health                     200  26ms
 POST   /workspaces/ws_V1St…/jobs   202  12ms
 GET    /jobs/job_0a1b2c3d4e5f      200  2.5ms
   → same request ×11 (avg 3.1ms)
```

- **Polling is collapsed.** `hf` following a job hits `GET /jobs/:id` every
  700 ms; identical consecutive requests within 2 s print once, then a
  `same request ×N` summary when the burst ends.
- **Warnings are specific:** `AUTH_ENABLED=true` with an empty `API_KEYS`
  ("auth is NOT active"), auth off while the port is reachable from the
  network, and an unconfigured AI provider (chat/summarize would return 503).
  Auth off on a localhost-only bind stays quiet.
- **Only on a terminal.** Under systemd, Docker, a pipe, or a file, the Gateway
  logs exactly what it always did - structured JSON from pino and plain
  `[tag] message` startup lines - so log aggregators and `grep` are unaffected.

| Env var | Effect |
|---|---|
| `LOG_FORMAT` | `auto` (default: pretty only on a terminal), `pretty` (force it, e.g. `npm run dev \| tee log`), `json` (never) |
| `NO_COLOR` | keep the layout, drop the color |
| `FORCE_COLOR` | color even when `LOG_FORMAT=pretty` is writing to a pipe |
| `HF_ASCII` | ASCII-only glyphs (also automatic for a non-UTF-8 locale or `TERM=linux`) |

It works by giving Fastify's pino logger a custom destination (`logger.stream`,
see `src/core/console-ui.ts`), so every existing log call - plugins' included -
is rendered without changing. `LOG_FORMAT` is read straight from the environment
rather than `config.ts`, so nothing `config.ts` imports can create a cycle.

## Running on PC (Windows/Mac/Linux)

Nothing about the Gateway itself is Android/Termux-specific except the
MT Manager integration.

```bash
cp .env.example .env
npm install
npm run dev
```

Install `jadx`/`apktool` the normal way for your OS (`brew install jadx`
on macOS, download-and-extract on Windows/Linux from
[jadx releases](https://github.com/skylot/jadx/releases) and
[apktool.org/docs/install](https://apktool.org/docs/install)) - both just
need to be on `PATH`. Point the `jadx`/`apktool` agents at any local file
path directly - `apkPath`/`inputDir` accept an absolute path on your
machine, no MT Manager required:

```bash
curl -X POST http://localhost:8080/workspaces/<id>/jobs \
  -H "Content-Type: application/json" \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "C:/Users/you/Downloads/app.apk"}}'
```

**`apkmcp` doesn't apply here** - it's built for MT Manager, an
Android-only app. There's no PC equivalent yet (a watched folder you
could drop APKs into instead of typing full paths - see the main
README's Roadmap section); for now, just use full paths.


## One-command install (Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/boy-offi9-inc/hexforge-gateway/main/docker-compose.yml -o docker-compose.yml \
  && docker compose up -d
```

(or `docker compose -f docker-compose.yml up -d` in a clone). This pulls the
published runtime image from GHCR - the Gateway plus the pinned RE toolchain -
binds the port to **127.0.0.1 only** (auth is off by default; see
[SAFETY](SAFETY.md) before exposing it), and keeps workspaces and data in
named Docker volumes. Health is checked against `/health`. adb/frida need a
device (see below).

## Running with Docker (pinned runtime)

The `Dockerfile.runtime` image ships the Gateway **plus the pinned RE
toolchain** - jadx 1.5.1, apktool 2.7.0, build-tools 34 (apksigner +
zipalign), APKiD 3.2.0, frida-tools 14.13.1, adb, and a JRE 17 - so a run
is reproducible: the tool versions recorded in artifact provenance are the
ones the image ships, and a scan today matches a scan next month.

```bash
docker build -f Dockerfile.runtime -t hexforge-runtime .

# run the Gateway with persistent data and workspaces
docker run -p 8080:8080 \
  -v hexforge-data:/app/data \
  -v hexforge-workspaces:/app/workspaces \
  hexforge-runtime

# verify the toolchain inside the image (exit 0 = all pinned tools healthy)
docker run --rm hexforge-runtime node scripts/check-runtime.mjs
```

Notes:

- The versions are pinned by build args at the top of `Dockerfile.runtime`;
  bump them there deliberately, one at a time, so provenance stays honest.
- `AUTH_ENABLED` stays off unless you pass it - see [Auth](#auth) before
  exposing the port beyond localhost.
- `adb` and `frida` need a device. Without one, those agents still load and
  fail cleanly; with USB passthrough (`--privileged -v /dev/bus/usb:/dev/bus/usb`)
  or a remote adb host they work fully.
- The tool-free MCP-introspection image (`Dockerfile`) is unchanged and is
  what Glama builds; introspection never needs the JVM/Python stacks.

## Running on Android (Termux + MT Manager)

Runs entirely on-device - Gateway and MT Manager as two apps on the same
phone, talking over loopback.

**1. Termux basics**

```bash
pkg update && pkg upgrade
pkg install nodejs git openjdk-17
termux-setup-storage   # grants access to /storage/emulated/0/... for apkPath payloads
```

**2. jadx and apktool** - neither ships in Termux's main repo, so install
manually: download from
[jadx releases](https://github.com/skylot/jadx/releases) and
[apktool's install page](https://apktool.org/docs/install), extract, and
put the executables on `PATH` (e.g. symlink into `$PREFIX/bin`). Confirm
both work standalone (`jadx --version`, `apktool --version`) before
pointing the Gateway at them.

**3. MT Manager's APK MCP** - in MT Manager, open the tools menu →
**APK MCP** → **SETTINGS**, point **MCP operation directory** at the folder
holding your APKs, **enable the floating ball**, then **START**. It listens
on `http://127.0.0.1:8787/mcp`, matching this project's default, so
Termux and MT Manager on the same device need no extra network setup.
Full walkthrough with screenshots, a verify command, and troubleshooting:
[`MT_MANAGER.md`](MT_MANAGER.md).

**4. Keeping the Gateway running** - Android kills backgrounded Termux
sessions to save battery. Run `termux-wake-lock` before long sessions. A
killed process is exactly the scenario `local-storage.provider.ts`'s
atomic writes are meant to survive cleanly - see
[Storage](#storage-local-default-or-supabase) above, and it's why local
storage is the default backend in the first place.

