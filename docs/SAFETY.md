# Safety model

What HexForge Gateway can touch, what it never touches, and what a client can
rely on before letting an agent run tools. Written for two audiences: the
operator deciding what to expose, and the agent client (Claude Code, a custom
MCP client) deciding whether to ask a human before each call.

## The one-line version

The Gateway analyzes what you point it at - it is local-only by design, it
modifies copies and never the original APK, secret values and captured
credential data are redacted by design, and every tool is annotated so a
client can gate the mutating ones.

## Network exposure

- **Binds `127.0.0.1` by default** (since v1.16.0) - the Gateway is a
  high-trust API: `adb shell` runs arbitrary commands on a connected device,
  `filesystem` writes and deletes files, `apktool`/`jadx` rebuild and resign
  APKs. The old all-interfaces default with auth off was exactly the wrong
  default for that combination. Localhost covers every documented workflow:
  a single operator, the MCP stdio server, and Docker with the published
  compose file (which binds `127.0.0.1` on the host).
- To listen beyond localhost, set `HOST=0.0.0.0` explicitly **and** turn auth
  on (`AUTH_ENABLED=true` + `API_KEYS`, see [SETUP](SETUP.md#auth)). On bare
  metal, startup **refuses to start** with a remote host and auth off - the
  message says exactly what to set. Inside a container, startup warns
  instead of refusing: the process can't see the host-side port mapping, and
  the published compose file keeps the real exposure on `127.0.0.1`. If you
  publish the port publicly from a container, auth becomes your job.
- `GET /health` reports `hostExposure` (`localhost-only` / `remote`) and a
  `degraded` flag (see below), plus the existing `authEnabled` (only `true`
  once a real key is configured) and `storageBackend`.
- Strict parsing: `AUTH_ENABLED=false` in the environment means auth **off**
  - a truthy-string coercion bug here would silently disable it, so the
  parse is strict and tested.
- `degraded` on `/health`: when the configured remote storage backend
  (postgres/supabase) fails a write and the local provider answers instead,
  the flag flips on and stays on. Those fallback writes are never replayed
  to the remote backend on recovery, so this is how an operator finds out
  the database is no longer the source of truth - reconciliation is a human
  decision, not an automatic one (see [SETUP](SETUP.md#storage-local-default-supabase-or-postgres)).
- The MCP server speaks stdio and inherits the operator's own credentials;
  it never opens a network listener by itself.

## What analysis touches

- **The device, when connected**: `adb` tools list devices, run shell
  commands, install APKs and read logcat; `frida` tools attach to processes.
  These are the highest-trust tools - an agent with them can do anything the
  device's user can. There is no confirmation layer inside the Gateway; gate
  them in your client (see below).
- **Files on disk**: `read_file` / `list_files` are read-only. Writes go
  through the decode -> patch -> rebuild -> sign loop on a **decoded copy**
  - the original APK file is never edited in place, and re-signed output
  carries a new signature so it cannot silently update the original app
  (see [APK_MODIFICATION](APK_MODIFICATION.md)).
- **Workspace files**: every writer that turns an id or filename into a
  path under `WORKSPACES_ROOT` goes through the shared containment guard
  (`src/utils/path-guard.ts`): a malformed id is refused before any path is
  built, and the resulting path is proven to stay inside the workspace's
  own directory - an uploaded capture or pulled file cannot land outside it.
- **The knowledge graph and findings**: `query_graph`, `get_graph_entity`,
  `list_*` and `verify_finding` are pure reads. `create_finding` /
  `update_finding` write workspace records only, are marked non-destructive,
  and validate their evidence against real artifacts on save.

## Redaction by design

- The secret scanner stores a **redacted candidate** (detector, confidence,
  fingerprint, signals) - the secret value itself is never written to disk,
  the graph, or a report.
- Traffic and runtime captures keep URL/host/method shapes and query
  parameter **names**; query **values** (tokens, session ids), header
  values, bodies, hook arguments, return values and stack traces are never
  stored.
- Audit/observability follows the same rule: identifiers and shapes, not
  captured secrets.

## Tool annotations

Every MCP tool carries spec annotations a client can enforce:

- `readOnlyHint: true` - does not modify the analyzed files or device
  (`search_code`, `read_file`, `list_files`, `triage_target`,
  `identify_packer`, `scan_secrets`, every `list_*` / `get_*` / `query_*`,
  `verify_finding`, `get_report`, and the inbox reads).
- `readOnlyHint: false` - touches the target: `decompile_apk`/`decode_apk`
  (write into workspace directories - `decode_apk` replaces the previous
  decode, and carries `destructiveHint: true`), `build_apk`,
  `patch_apk_project` (exact-text edit inside a decoded project, tracked
  with before/after hashes), `sign_apk`, the `adb_*` / `frida_*` device
  tools, and the AI tools (`chat_with_workspace`, `summarize_text`). Each
  carries `destructiveHint` and `idempotentHint` so a client can escalate
  further: the confirm-before-running set is `decode_apk`,
  `patch_apk_project`, `sign_apk`, `adb_install` and `adb_shell`.

Honesty note, stated in the tool source itself: `readOnlyHint: true` means
"doesn't modify the files/device you're analyzing", not "writes nothing
anywhere" - a workspace-scoped call creates the workspace record and job
history entry. That is Gateway bookkeeping, not target mutation.

## Agent-executed processes

External tools (jadx, apktool, apksigner, adb, frida, ghidra) are spawned
with **direct argv, never through a shell** - there is no command-string
interpolation to inject into. The processes run with the Gateway's own
privileges; least-privilege operators should run the Gateway under a
dedicated user.

## Plugins and untrusted input

- Plugins are loaded from a configured directory at startup and run **in
  process with full privileges** - only install plugins you have read.
- Hostile input is expected and bounded: malformed captures and hostile
  query strings are skipped per-event rather than failing the capture,
  entity/edge caps bound indexing, and the evidence verifier reads only
  inside the artifact it was pointed at.

## What a client should enforce

The Gateway is a tool provider, not a jail. For unattended agent runs:

1. Set `AUTH_ENABLED=true` + `API_KEYS` and bind to a non-public interface
   if the analysis is sensitive.
2. Confirm-list the mutating tools (`decode_apk`, `patch_apk_project`,
   `sign_apk`, `adb_install`, `adb_shell`) in your client before
   auto-running them.
3. Keep the device you attach to disposable or owned - `adb_shell` is
   arbitrary code execution on that device by definition.
