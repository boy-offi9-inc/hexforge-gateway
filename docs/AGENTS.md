# MCP Agents

`src/modules/mcp/orchestrator.ts` registers a handler per agent kind.
`jadx`, `apktool`, `apkid`, `apkmcp`, `filesystem`, `adb`, and `frida` all
have real implementations - `frida` has the biggest asterisk on "real"
(see below). Dispatching a task (`POST /workspaces/:id/tasks`) is
fire-and-forget: it returns immediately with `status: "queued"`, then
moves to `running` then `completed`/`failed` as the handler runs - poll
`GET /workspaces/:id/tasks` or watch `/ws` for the result, same as Jobs.

### filesystem

For browsing/searching jadx/apktool output without leaving the API, or
general file management scoped to a workspace. Trust model:
`list`/`read`/`stat`/`search` accept any absolute path on the machine
(same as `jadx`/`apktool` already trust an arbitrary `apkPath`) - `write`
and `delete` are sandboxed to the workspace's own directory under
`WORKSPACES_ROOT/<workspaceId>/`, since those are destructive.

```bash
# search decompiled output for permission strings
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "filesystem", "operation": "search", "payload": {"dirPath": "<jadx output dir>", "pattern": "android\\.permission\\.[A-Z_]+"}}'
```

Operations: `list` (`dirPath`, `recursive?`, `limit?`), `read` (`filePath`,
`encoding?: "utf8"|"base64"`), `write` (`filePath`, `content`, `encoding?`
- sandboxed), `delete` (`filePath` - sandboxed), `stat` (`filePath`),
`search` (`dirPath`, `pattern` - a regex, `caseSensitive?`, `extensions?`,
`maxResults?`), `scan-secrets` (`dirPath`, `extensions?`, `maxResults?`) -
same walk-and-match machinery as `search`, but against a curated built-in
set of high-precision patterns (AWS/Google API keys, private key headers,
Slack/GitHub tokens, JWTs) instead of a user-supplied one. Deliberately
not exhaustive - favors patterns distinctive enough to keep false
positives low over generic ones like `password=...` that would flood
results with test fixtures. Not a replacement for a maintained
secret-scanner (gitleaks, trufflehog) on anything that actually matters.

`search`'s pattern is user-supplied (and `scan-secrets`' built-in
patterns are still regexes) and regex engines can be tricked into
catastrophic backtracking (e.g. `(a+)+` against a non-matching input can
hang effectively forever). Since a single synchronous `RegExp.test()`
call can't be interrupted once started, both run in a worker thread
(`filesystem.search.worker.ts`) with a 10s timeout - hitting it kills the
worker and returns a clear timeout error instead of a hung request.

### adb

Requires `adb` on `PATH`. Talks to whatever device/emulator you already
have adb access to - `deviceSerial` is optional on every operation, only
needed with more than one device connected.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "adb", "operation": "install", "payload": {"apkPath": "<rebuilt apk>", "reinstall": true}}'
```

Operations: `devices`, `packages` (`filter?`), `install` (`apkPath`,
`reinstall?`), `uninstall` (`packageName`, `keepData?`), `shell`
(`command`), `logcat` (`filter?`, `lines?` - dumps and tails the current
buffer rather than streaming live, matching this Gateway's
request/response model), `pull` (`remotePath`, `fileName?` - saved under
`WORKSPACES_ROOT/<workspaceId>/adb/pulled/`), `push` (`localPath`, `remotePath`).

`shell` runs whatever command you give it on the device - as powerful as
`adb shell` itself. Fine for a local, single-user tool; don't expose the
Gateway beyond localhost without turning on Auth first.

### frida

Frida is fundamentally interactive/streaming - attach, inject, watch
hook events live for as long as you want. This Gateway is
request/response, so `trace` compromises the same way `adb logcat` does:
spawn or attach, inject a script, capture whatever it emits within a
bounded window, then kill it. For a real interactive session, use the
`frida` CLI directly - this agent is for "run this hook for N seconds and
tell me what happened."

Requires `frida-tools` on `PATH` and a `frida-server` running on the
target device, **matching your frida-tools version** - the single most
common Frida failure is a version mismatch between the two.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "agent": "frida", "operation": "trace",
    "payload": {
      "target": "com.example.app",
      "script": "Java.perform(function () { console.log(\"attached\"); });",
      "timeoutSeconds": 15
    }
  }'
```

Operations:
- `list-devices` — `frida-ls-devices`
- `list-processes` (`deviceSerial?`, `includeApps?`) — `frida-ps`, optionally with installed (not just running) apps
- `push-server` (`localServerPath`, `deviceSerial?`, `remotePath?`) — adb-pushes a `frida-server` binary and chmods it executable
- `start-server` / `stop-server` (`deviceSerial?`, `remotePath?`) — best-effort, **requires root**; backgrounding over a single `adb shell` call is fragile by nature, verify with `list-processes` rather than trusting the response alone
- `trace` (`target`, `mode?: "spawn"|"attach"`, `script`, `timeoutSeconds?` - default 15, capped at 60) — `target` is a package name in `spawn` mode, or a PID/process name in `attach` mode; `script` is raw Frida JS, written to `WORKSPACES_ROOT/<id>/frida/scripts/` before running

Timing out isn't a failure - it's the expected way `trace` ends, since a
script has no way to signal "I'm done" back to this agent. The
response's `timedOut` field tells you which happened; `stdout`/`stderr`
contain whatever the script emitted before the window closed either way.
Non-root devices need Frida's Gadget-based injection instead of a
`frida-server` push, which this agent doesn't implement.

### jadx

Requires `jadx` on `PATH`. Produces readable Java-like source for browsing.

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'
```

Output goes to `WORKSPACES_ROOT/<workspaceId>/jadx/`; the result contains
the output directory and a capped file listing.

### apktool

Requires `apktool` on `PATH`. Unlike `jadx`, decodes resources to
editable XML and disassembles code to **smali** - and can rebuild an APK
from a decoded project, which `jadx` cannot do. Use it to modify and
repackage an app, not just read it.

```bash
# decode
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "decode", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'

# rebuild after editing the decoded project
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "build", "payload": {"inputDir": "<decode output dir, edited>", "outputName": "rebuilt.apk"}}'
```

Decode output: `WORKSPACES_ROOT/<workspaceId>/apktool/decode/`. Optional
decode flags: `noSrc: true` (resources only, faster), `noRes: true`
(smali only). Build output:
`WORKSPACES_ROOT/<workspaceId>/apktool/build/<outputName>`.

**Important:** the rebuilt APK is unsigned and won't install until
signed - this project doesn't wire up signing for the apktool path. Use
`apkmcp`'s build flow (signs automatically) for a signed result, or sign
manually with `apksigner`. Only rebuild and install apps you own or are
authorized to modify.

### apkid

Requires `apkid` on `PATH` (`pip install apkid` - needs a yara-python
build with DEX support first, see
[APKiD's install docs](https://github.com/rednaga/APKiD#installation),
plain `pip install yara-python` isn't enough). Wraps
[APKiD](https://github.com/rednaga/APKiD), a real, actively-maintained
YARA-rules-based fingerprinter for compilers, packers, obfuscators, and
anti-debug/anti-VM tricks - deliberately not reimplemented as a weaker
heuristic here, since APKiD's rules are maintained by people who actually
track new packers.

```bash
curl -X POST http://localhost:8080/workspaces/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkid", "operation": "identify", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'
```

Operation: `identify` (`apkPath`, `timeoutSeconds?` - per-file YARA scan
timeout, default 30). Output is APKiD's own JSON passed through as-is,
not reshaped into a HexForge-specific structure - that schema belongs to
APKiD, not duplicated and drifted out of sync here.

### apkmcp

A generic Model Context Protocol client with convenience operations
built for MT Manager's built-in "APK MCP" service (Android only - see
`docs/SETUP.md` and `MT_MANAGER_MCP_SETUP.md` for setup). Default target
`http://127.0.0.1:8787/mcp`; override with `baseUrl` in the payload.

| operation | payload fields | maps to |
|---|---|---|
| `list_tools` | — | `tools/list` |
| `list_available_apks` | `prefix?`, `limit?` | `mt_apk_list_available_apks` |
| `open` | `path`, `temporary?` | `mt_apk_open` |
| `list` | `workspaceId`, `view?`, `prefix?`, `limit?` | `mt_apk_list` |
| `outline_class` | `workspaceId`, `locator` | `mt_apk_outline_class` |
| `read_text` | `workspaceId`, `locator` | `mt_apk_read_text` |
| `search` | `workspaceId`, `query`, `target?` | `mt_apk_search` |
| `close` | `workspaceId` | `mt_apk_close` |
| `call_tool` | `tool`, `arguments` | escape hatch for anything else |

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "open", "payload": {"path": "apks/app.apk", "temporary": false}}'

# grab the returned data.workspaceId, then:
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apkmcp", "operation": "list", "payload": {"workspaceId": "<mtWorkspaceId>", "view": "dex_classes"}}'
```

Note: MT's `path` must be **relative** to its configured "MCP operation
directory" - absolute paths are rejected. Use `list_available_apks` if
unsure of the relative path.

`mt_apk_edit_*` and `mt_apk_build` (which can modify and re-sign an APK)
aren't wrapped in a convenience operation - use `call_tool` directly, and
only point them at apps you own or are authorized to modify.

