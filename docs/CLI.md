# CLI (`hf`) and Automated Smoke Test

For manual use from a terminal (or Termux), copying generated ids out of
every response into the next command gets old fast. `hf` wraps the API and
remembers your current workspace / job / workflow between commands, so
most commands need zero ids typed - and, in a terminal, it looks like a
tool rather than a JSON dump: branded, colored, with live progress.

```bash
chmod +x scripts/hf.sh   # once
alias hf=./scripts/hf.sh # optional, from the repo root (or: npm run hf -- <args>)

hf                                   # orientation: gateway status, commands, your workspaces
hf ws clite-analysis                 # get-or-create workspace "clite-analysis", becomes current
hf inbox                             # APKs dropped into the server's inbox folder (docs/INBOX.md)
hf job jadx decompile apkPath=/storage/emulated/0/MT2/apks/app.apk
hf job-status                        # no id needed - uses the job just submitted
hf wf analyze '[{"agent":"jadx","operation":"decompile","payload":{"apkPath":"/path/app.apk"}}]'
hf knowledge                         # knowledge entries for the current workspace
hf chat                              # interactive chat - see below
hf current                           # what's currently selected
```

Set `HEXFORGE_URL` if the Gateway isn't on `localhost:8080`, and
`HEXFORGE_API_KEY` if `AUTH_ENABLED=true`. Only Node is required - the same
Node the Gateway runs on. (`hf.sh` is now a thin launcher around
`scripts/hf/cli.mjs`; it used to be a `curl` + `jq` script, so neither is
needed any more for `hf`.)

## Two output modes

`hf` picks one automatically:

- **Pretty** - when stdout is a terminal. Cards, status icons, a branded
  header on `hf` / `hf chat`, rendered markdown in chat replies. `hf job` and
  `hf wf` **follow the run live** (a spinner for a job; an in-place step
  list for a workflow) and collapse into a result card when it finishes.
  Ctrl+C stops *watching*, not the job - it keeps running in the Gateway,
  and the message tells you the command to pick it back up.
- **Plain** - when stdout is a pipe or file, or you pass `--plain`, `--json`,
  or set `HF_PLAIN=1`. This is exactly what the original bash script
  printed: indented JSON on stdout, "Current workspace: ..." notices on
  stderr, no waiting. Scripts that parse `hf` output keep working.

| Flag | Effect |
|---|---|
| `--json` | raw JSON, never styled (implies `--plain`) |
| `--plain` | the original unstyled output |
| `-d`, `--detach` | submit a job/workflow and return, don't follow it |
| `-w`, `--wait` | follow even in plain mode - prints the final JSON, **exits 1 if the job/workflow failed** (handy in scripts) |
| `--attempts N` | retry a job up to N times (1-10) |
| `--no-color` | monochrome, same layout (also honors `NO_COLOR`) |
| `--ascii` | ASCII-only glyphs (also `HF_ASCII=1`; chosen automatically for a non-UTF-8 locale or `TERM=linux`) |

Flags can go anywhere: `hf job jadx decompile apkPath=/x.apk --detach`.
Exit codes: `0` ok, `1` the Gateway/job/workflow failed, `2` you typed it wrong.

It's designed for a phone first: lists are cards (a title line, a muted
detail line) rather than wide tables, and everything wraps or truncates by
*visible* width - checked down to a 24-column terminal.

## Job payloads

Either one JSON object, or HTTPie-style pairs - no shell-quoting a JSON blob
on a phone keyboard:

```bash
hf job jadx decompile '{"apkPath": "/x.apk"}'          # JSON, as before
hf job jadx decompile apkPath=/x.apk                    # key=value  -> always a string
hf job adb install apkPath=/x.apk reinstall:=true       # key:=json  -> any JSON value
hf job frida trace target=com.x.app timeoutSeconds:=30 script="console.log(1)"
```

`key=value` is *never* type-guessed (`command=123` stays the string `"123"`);
use `:=` when you want a number, boolean, array, or object.

## Terminal chat

```bash
hf ws clite-analysis
hf chat
```

A proper REPL: line editing, up-arrow history that persists across sessions
(`~/.hexforge/chat_history`), a spinner while the model thinks, and replies
rendered as markdown (bullets, `code`, fenced blocks, bold). Slash commands:
`/log [n]` (last n messages), `/clear`, `/help`, `/exit`. Ctrl+C clears what
you've typed; Ctrl+C on an empty line twice, or Ctrl+D, leaves.

Every message and reply is a real request to `POST /workspaces/:id/chat`
(nothing client-side is faked), so the conversation is the same one `hf
chat-log` or `GET /workspaces/:id/chat` shows later, from another terminal,
or eventually a web UI. Remember the assistant sees only the chat history,
not the workspace's reports or job results (see `docs/AI.md`) - paste in what
a question depends on.

In plain mode (`hf chat < questions.txt`, or piped) it keeps the original
contract: prompts on stderr, `ai>` replies on stdout.

## State, environment, and files

| | |
|---|---|
| `~/.hexforge/state.env` | current workspace / job / workflow - the **same file and format** the bash version used, so switching between them loses nothing, and bash can still `source` it |
| `~/.hexforge/chat_history` | chat input history |
| `HF_STATE_DIR` | use a different directory for both (the tests do this) |
| `HEXFORGE_URL`, `HEXFORGE_API_KEY` | which Gateway, and its key |
| `NO_COLOR`, `FORCE_COLOR`, `HF_PLAIN`, `HF_ASCII` | terminal behavior, see above |
| `HF_DEBUG=1` | print a stack trace on unexpected errors |

## Layout, and extending it

```
scripts/hf.sh          launcher (finds Node, runs scripts/hf/cli.mjs; follows symlinks)
scripts/hf/cli.mjs     commands, live follow views, the chat REPL
scripts/hf/ui.mjs      pure styling: colors, glyphs, boxes, cards, wrapping, markdown
scripts/hf/client.mjs  fetch wrapper (typed errors), state file
```

`ui.mjs` takes everything it needs - color depth, unicode, width - through
`createTheme()` and never reads the environment or a stream, which is why
it's unit-tested (`tests/cli.test.ts`) without a terminal. Two rules when
adding output: build it from the theme (`t.truncate`, `t.card`, `t.hint`, ...)
rather than raw strings and a hard-coded `…`, or ASCII mode and narrow
terminals break; and give every command a plain-mode branch that prints JSON,
because that's the scripting contract. Free-form text (like chat messages)
needs no special escaping any more - it goes through `JSON.stringify`.

Not covered by automated tests: the live spinner, the in-place workflow
redraw, the chat REPL, and Ctrl+C handling need a real terminal. They were
exercised by hand against a fake Gateway inside a pseudo-terminal.

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

Same `HEXFORGE_URL` / `HEXFORGE_API_KEY` env vars as `hf`. Unlike `hf` (which only needs Node), the smoke test is still a bash script and needs `curl` and `jq`.

