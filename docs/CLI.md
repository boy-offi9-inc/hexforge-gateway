# CLI Wrapper (scripts/hf.sh) and Automated Smoke Test

For manual testing (curl from a terminal/Termux), copying generated ids
out of every response into the next command gets old fast. `hf.sh` wraps
the API and remembers the current workspace/job/workflow id in
`~/.hexforge/state.env`, so most commands need zero ids typed:

```bash
chmod +x scripts/hf.sh   # once
alias hf=./scripts/hf.sh # optional, from the repo root

hf ws clite-analysis                 # get-or-create workspace "clite-analysis", becomes current
hf ws-list                           # see every workspace that exists on the server
hf job jadx decompile '{"apkPath": "/storage/emulated/0/MT2/apks/Clite Dialer_1.0.apk"}'
hf job-status                        # no id needed - uses the job just submitted
hf wf analyze '[{"agent":"jadx","operation":"decompile","payload":{"apkPath":"/path/app.apk"}}]'
hf wf-status                         # no id needed - uses the workflow just submitted
hf knowledge                         # list knowledge entries for the current workspace
hf chat                              # interactive terminal chat - see below
hf current                           # show what's currently selected
```

Set `HEXFORGE_URL` if the Gateway isn't on `localhost:8080`, and
`HEXFORGE_API_KEY` if `AUTH_ENABLED=true`. Requires `curl` and `jq`. Run
`hf` with no args to get oriented - prints the full command list plus
your current workspace and every workspace on the server, so a
first-time contributor never has to guess an id or read this README
before doing anything.

### Terminal chat

```bash
hf ws clite-analysis
hf chat
```

Drops into a REPL - type a message, get a reply, repeat; `exit`, `quit`,
or Ctrl+D to leave. Every message and reply is a real request to `POST
/workspaces/:id/chat` (nothing client-side is faked), so the same
conversation is visible via `hf chat-log` or `GET /workspaces/:id/chat`
later, from a different terminal, or eventually a web UI.

Implementation note if you're extending `hf.sh`: chat input is genuinely
free-form text (quotes, backslashes, newlines - anything), unlike every
other command's inputs here which are controlled (ids, package names,
JSON typed carefully). `chat` builds its request body with
`jq -n --arg`, which JSON-encodes the string properly regardless of
content - naive string interpolation would break the moment someone
typed a quote mark. Reuse `jq -n --arg` for any new free-text command.

### Automated smoke test (scripts/smoke-test.sh)

```bash
./scripts/smoke-test.sh
```

End-to-end pass over everything that doesn't need external Android
tooling: workspace get-or-create, the `filesystem` agent
(write/read/search/delete, plus confirming a write *outside* the
workspace dir is correctly refused), a Job, a Workflow (including
`mergePreviousResult` and confirming the Knowledge Indexer auto-created
a report entry), Knowledge Engine CRUD, AI (a summarize job plus a full
chat round-trip - skipped with a clear reason if unconfigured), and the
Plugin System (`GET /plugins`, plus actually running the
`example-strings` agent if `strings` is on `PATH`). Prints
`[PASS]`/`[FAIL]`/`[SKIP]` per check and a summary; exits non-zero on
any failure.

Leaves the workspace it creates in place afterward
(`smoke-test-<timestamp>`) rather than cleaning up, so you can inspect
real data with `hf ws-id <id>` / `hf knowledge` instead of it vanishing
when the script exits. Prints exact `hf` commands at the end for what it
can't test itself: `jadx`/`apktool` (need a real `.apk`), `adb` (needs a
device/emulator), `frida` (needs frida-tools + frida-server), `apkmcp`
(needs MT Manager running on Android).

Same env vars as `hf.sh`.

