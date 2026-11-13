# MCP Agents

`src/modules/mcp/orchestrator.ts` registers a handler per agent kind.
`jadx`, `apktool`, `apksigner`, `apkid`, `apkmcp`, `filesystem`, `adb`, and `frida` all
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
same walk-and-match machinery as `search`, but against a built-in
multi-detector registry (24 detectors: AWS/Google/Azure keys, private key
headers, GitHub/GitLab/Slack/Stripe/Twilio/SendGrid/Mailgun/NPM/PyPI
tokens, JWTs, webhook URLs, high-entropy key shapes) instead of a
user-supplied pattern. Deliberately not exhaustive - favors detectors
distinctive enough to keep false positives low. Not a replacement for a
maintained secret-scanner (gitleaks, trufflehog) on anything that
actually matters.

Each raw hit is re-scored into a **secret candidate**:
`detector` + `file` + `line`, a **redacted context line** (the matched
text replaced with `[REDACTED:<length>]`), a 4-character `preview`, the
match `length`, a SHA-256 `fingerprint` (stable id for dedupe, never
reversible), a `confidence` (`low`/`medium`/`high`) and the `signals`
that produced it - entropy of the match, context keywords on the line
(`aws_secret_access_key = ...` raises an AWS-secret-shaped hit), and
placeholder/example shapes (`AKIAIOSFODNN7EXAMPLE`, `changeme`) that
force `low`. The candidate never contains the secret text itself, and
neither does the saved result file - the matched line is stored
redacted.

`scan-secrets` also saves its full result (redacted candidates included)
as `WORKSPACES_ROOT/<id>/filesystem/scan-secrets/<taskId>.json` and
returns the path as `outputPath`, so a scan can be recorded as an
[artifact](ARCHITECTURE.md#artifacts) and cited as evidence. Each run gets its
own file; earlier scans are never overwritten. If the file can't be written
the scan still succeeds, just without an `outputPath`.

Every `secret-scan` artifact is also indexed into the knowledge graph
(`graph/secret-indexer.ts`): one `secret-candidate` entity per candidate
(`detector:path:line` as the name, fingerprint/preview/length/confidence/
signals as attributes), merged by derived id so re-scanning the same file
updates the same entities instead of duplicating them.

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
The full result is also saved as `WORKSPACES_ROOT/<id>/frida/traces/<taskId>.json`
and its path returned as `outputPath`, so a trace can be recorded as an
[artifact](ARCHITECTURE.md#artifacts) and cited as evidence.
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

# edit one file of the decoded project: replace exact text
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "patch", "payload": {"projectDir": "<decode output dir>", "file": "AndroidManifest.xml", "find": "debuggable=\"false\"", "replace": "debuggable=\"true\""}}'

# rebuild after editing the decoded project
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "build", "payload": {"inputDir": "<decode output dir, edited>", "outputName": "rebuilt.apk"}}'
```

Decode output: `WORKSPACES_ROOT/<workspaceId>/apktool/decode/`. Optional
decode flags: `noSrc: true` (resources only, faster), `noRes: true`
(smali only). Build output:
`WORKSPACES_ROOT/<workspaceId>/apktool/build/<outputName>`.

`patch` replaces exact text in one file of the decoded project (`projectDir`, `file`
relative to it, `find`, `replace`, optional `all`). The text must be found, and must
match exactly once unless `all` is true; paths that leave the project, binary files and
files over 5 MB are refused. Each patch saves a record - the lines changed and SHA-256
hashes of the file before and after, no machine paths - and returns its path as
`outputPath`, so it is recorded as an `apk-patch` [artifact](ARCHITECTURE.md#artifacts).
The result's keys avoid `file`, `find` and `replace`, so it can be merged into the next
step of a workflow. `build` also accepts `projectDir` and `outputDir` in place of
`inputDir`, for the same reason.

**Important:** the rebuilt APK is unsigned and won't install until signed - use the
`apksigner` agent below. The whole loop is walked through in
[`APK_MODIFICATION.md`](APK_MODIFICATION.md). Only rebuild and install apps you own or are
authorized to modify.

### apksigner

Aligns and signs an APK so it installs. One operation, `sign`:

```bash
curl -X POST http://localhost:8080/workspaces/<workspaceId>/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apksigner", "operation": "sign", "payload": {"apkPath": "/absolute/path/to/rebuilt.apk"}}'
```

Payload: `apkPath` (or the previous workflow step's `outputPath`), optional `outputName`
(a file name, not a path) and `flavor` (`sdk` or `lite`, normally detected). The signed
copy is written to `WORKSPACES_ROOT/<workspaceId>/apksigner/signed/<name>-signed.apk` and
the result has `outputPath`, `apkPath` (the same path, under the key `adb install` reads),
`flavor`, and for the SDK flavor `aligned` and `schemes` (the signature schemes that
verified). Anything skipped is in `warnings`.

It signs with a **debug key** generated on first use (`DATA_DIR/signing/debug.keystore`).
The signature therefore differs from the original app's: the result can't update the
original in place - uninstall that first - and isn't for distribution. Two programs are
named `apksigner`: the Android SDK's, used with `zipalign` and `keytool`, and the
lightweight one in Termux's package, which aligns for itself. The agent tells them apart by
`--version`. Which signature schemes Termux's lightweight one writes isn't confirmed;
if an install fails with a signature error, sign with the SDK's. A signed APK that doesn't
verify is deleted rather than left behind.

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
built for MT Manager's built-in "APK MCP" service (Android only - setup
in [`MT_MANAGER.md`](MT_MANAGER.md)). Default target
`http://127.0.0.1:8787/mcp`; override with `baseUrl` in the payload.

| operation | payload fields | maps to |
|---|---|---|
| `list_tools` | — | `tools/list` |
| `list_available_apks` | `prefix?`, `limit?` | `mt_apk_list_available_apks` |
| `open` | `path`, `temporary?` | `mt_apk_workspace_open` (older MT: `mt_apk_open`) |
| `list` | `workspaceId`, `view?`, `prefix?`, `limit?` | `mt_apk_list` |
| `outline_class` | `workspaceId`, `locator` | `mt_apk_dex_read_class_outline` (older MT: `mt_apk_outline_class`) |
| `read_text` | `workspaceId`, `locator` | `mt_apk_read_text` |
| `search` | `workspaceId`, `query`, `target?` | `mt_apk_search` |
| `close` | `workspaceId`, `force?` | `mt_apk_workspace_delete` (older MT: `mt_apk_close`) |
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

MT renames tools between versions, so `open`, `outline_class` and `close` use
whichever name MT's `tools/list` reports, newest first (the list is read once
per server and remembered for a minute). If MT has none of the names, the
error says which were tried and what MT does offer; if `tools/list` can't be
read, the newest name is tried.

`open`'s `path` can be a Home-relative path from `list_available_apks`,
`mt://current-apk`, `mt://workspace/<id>` with `temporary: false` to reopen a
saved workspace, or an absolute path that MT's access policy allows (the
`mt_file_get_access_policy` tool shows it). Use `temporary: true` for a
one-time workspace you'll delete when done.

`close` is `mt_apk_workspace_delete` on current MT, which deletes the
workspace and every edit session under it. MT's guidance is to keep saved
(non-temporary) workspaces, so `close` **refuses to delete one** unless the
payload has `"force": true`, and refuses too if MT can't say whether the
workspace is saved. Temporary workspaces are deleted without it.

MT's edit, patch and build tools (`mt_apk_edit_text`, `mt_apk_resource_edit`,
`mt_apk_resource_add`, `mt_apk_patch_bytes`, `mt_apk_native_patch_*`,
`mt_apk_delete_target`, `mt_apk_copy_entry`, `mt_apk_build`) can modify and
re-sign an APK, and the `mt_file_*` and `mt_zip_*` tools can write, move and
delete files and archives. None of them has a convenience operation - use
`call_tool` directly, and only point them at apps and files you own or are
authorized to modify. [`MT_TOOLS.md`](MT_TOOLS.md) lists all 57 MT tools and
which can change things.

## Capabilities

Every built-in agent describes what it can do, independent of which tool does
it, and `GET /capabilities` lists the result. A capability is a dotted id such
as `java.decompile`, `android.rebuild` or `instrument.server`; each lists the
agents that provide it, the operations they offer for it, and a priority
(higher wins when several agents provide the same capability).

```bash
curl http://localhost:8080/capabilities
```

```json
{
  "capabilities": [
    {
      "id": "java.decompile",
      "providers": [{ "agent": "jadx", "operations": ["decompile"], "priority": 0 }]
    }
  ],
  "adapters": [{ "kind": "jadx", "backends": [{ "tool": "jadx" }], "operations": ["..."] }]
}
```

`adapters` carries each agent's full descriptor: backend tools, permissions,
and each operation's required/optional payload keys and declared outputs. It
is read-only introspection - dispatching still goes through
`POST /workspaces/:id/tasks`. An operation's declared `outputs` also decide
which results are recorded as [artifacts](ARCHITECTURE.md#artifacts). Plugins join the same list by passing a
descriptor to `ctx.registerAgent` (see [PLUGINS](PLUGINS.md)).
