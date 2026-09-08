# Setup

Device requirements, Auth, Storage backend choice, and platform-specific
(PC/Android) setup - everything needed to get a working Gateway running
and configured, as opposed to how any given feature works internally.

## Device requirements

Minimums, not comfort levels - the Gateway itself is a lightweight Node
process, but jadx/apktool are JVM tools that can get memory- and
CPU-hungry on large or heavily obfuscated APKs.

**Software (either platform):**
- Node.js 20+
- `jadx` and `apktool` on `PATH` if you'll use those agents (both need a JVM - `openjdk-17` or similar)
- `adb` on `PATH` for the `adb` agent (Android platform-tools)
- `frida-tools` (`pip install frida-tools`, needs Python) plus a matching `frida-server` on the target device for the `frida` agent - the version match between the two is the most common Frida failure
- `apkid` (`pip install apkid`, needs a yara-python build with DEX support) for the `apkid` agent
- `curl` + `jq` for `scripts/hf.sh` and `scripts/smoke-test.sh`

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
for a cloud AI provider, `STORAGE_BACKEND=supabase`, or the
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

The CLI wrapper picks this up automatically - set `HEXFORGE_API_KEY` and
every `hf`/`smoke-test.sh` command sends it.

This is deliberately simple: one flat list of shared keys, no per-key
scopes, no expiry, no user accounts. Fine for a single operator's own
devices; if this project grows into something with actual multiple
untrusted users, `core/auth.ts` is the one file to replace, not extend.


## Storage: local (default) or Supabase

`STORAGE_BACKEND` picks where `workspaces` and `knowledge_entries` live:

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

To use Supabase: create a project, run `supabase.schema.sql` in the SQL
editor, then set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`STORAGE_BACKEND=supabase` in `.env`. `GET /health`'s `storageBackend`
field confirms which mode is actually active.

Worth knowing either way:

- **No sync between the two.** Anything written to local storage while
  on `supabase` mode during an outage stays local-only - check
  `data/*.json` for anything written during the gap if that matters.
  Switching `local` → `supabase` later doesn't auto-migrate existing
  local data either.
- **Not a real database.** No indexing, no migrations, no query language
  - a flat `{ id: record }` JSON map per collection. Concurrent writes
  *within one process* are safe (`upsertRecord`/`deleteRecord` serialize
  per collection so two requests racing on the same collection can't
  silently drop one's write) but that doesn't extend across multiple
  processes sharing one `DATA_DIR`, which isn't a supported setup.
- **Jobs and Workflows are still in-memory only**, regardless of
  `STORAGE_BACKEND` - no local-storage or Supabase branch yet for those
  (see the note in `supabase.schema.sql`).

Falling back is logged (`[workspace.service] Supabase ... failed,
falling back to local storage: ...`), so it's visible rather than silent.


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

**3. MT Manager's APK MCP** - full setup with screenshots in
[`MT_MANAGER_MCP_SETUP.md`](../MT_MANAGER_MCP_SETUP.md); short version:
open MT Manager's tools menu → **APK MCP** (between Terminal Simulator
and Activity Record) → **SETTINGS** → set **MCP operation directory** to
wherever your APKs live (e.g. `/storage/emulated/0/MT2/apks` - MT only
accepts paths relative to this directory) → **enable the floating ball**
(off by default; Android backgrounding MT Manager without it is the most
common reason `apkmcp` calls fail intermittently) → **OK** → **START**.
Defaults to `http://127.0.0.1:8787/mcp`, matching this project's
default. Since Termux and MT Manager run on the same device, loopback is
directly reachable with no extra network setup.

Verify:
```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "list_available_apks", "payload": {}}'
```
If that fails and APK MCP shows as running on the phone, the floating
ball setting is the first thing to check, not the Gateway config.

**4. Keeping the Gateway running** - Android kills backgrounded Termux
sessions to save battery. Run `termux-wake-lock` before long sessions. A
killed process is exactly the scenario `local-storage.provider.ts`'s
atomic writes are meant to survive cleanly - see
[Storage](#storage-local-default-or-supabase) above, and it's why local
storage is the default backend in the first place.

