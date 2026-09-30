# Inbox Watcher (the "PC-side APK MCP")

On Android, the `apkmcp` agent (`docs/AGENTS.md`) talks to MT Manager's APK
MCP service, which lets you visually pick an APK in MT Manager and hand its
path over without typing it. A PC has no MT Manager - the inbox watcher is
the same convenience by a different mechanism: drop an `.apk` file into a
watched folder, and it gets claimed into its own workspace automatically.
No full path to type or paste into a tool call, on either platform.

## Setup

Unset by default - dropping this in front of a fresh clone with no
`APK_INBOX_DIR` set does nothing at all. Set it to enable:

```bash
APK_INBOX_DIR=./inbox
```

(relative paths resolve against the Gateway process's cwd, same as
`WORKSPACES_ROOT`/`DATA_DIR`). The folder is created automatically if it
doesn't exist yet. Restart the Gateway - the watcher starts alongside
Job/Workflow hydration, logs `[inbox-watcher] watching <path> every
1000ms...` on success, or a reminder that it's disabled if the var is unset.

`APK_INBOX_POLL_MS` (default `1000`) controls how often it checks the
folder - see "Why polling, not fs.watch()" below before lowering it much.

## What happens when you drop a file

1. You copy/move `MyApp-v2.apk` into the inbox folder.
2. Once it's stopped changing size for one full poll interval (see below),
   the watcher:
   - derives a workspace name from the filename - `MyApp-v2.apk` becomes
     `myapp-v2` - and gets-or-creates that workspace (so re-dropping a
     newer build of the same app, with the same filename, lands in the
     same workspace you're already tracking, on purpose)
   - **moves** (not copies) the file to
     `<WORKSPACES_ROOT>/<workspaceId>/inbox/MyApp-v2.apk` - moved so the
     inbox folder doesn't quietly accumulate a permanent copy of every
     APK you've ever dropped into it
   - writes a `note` knowledge entry recording where it landed, so
     `list_knowledge` or a chat turn can surface it
3. Fetch the resolved path any time via `GET /workspaces/:id/inbox` or the
   `get_inbox_apks` MCP tool - both just list whatever's actually in that
   workspace's own `inbox/` directory on disk. That's the real payoff:
   an AI driving HexForge through the MCP tools can call
   `get_inbox_apks({workspace: "myapp-v2"})`, get a real `apkPath` back,
   and pass it straight to `decompile_apk`/`decode_apk`/etc. - the human
   never has to tell it the path either.

```bash
curl http://localhost:8080/workspaces/ws_abc123/inbox
# {"apks":[{"fileName":"MyApp-v2.apk","path":"/abs/path/.../inbox/MyApp-v2.apk","sizeBytes":8421376,"detectedAt":"2026-09-30T12:00:00.000Z"}]}
```

An empty `apks: []` means either nothing's been dropped for that
workspace yet, or `APK_INBOX_DIR` isn't configured on this server at all -
the route can't tell those two apart (there's no separate "watcher
enabled" flag to check), since both simply mean "nothing's in this
workspace's inbox directory."

## Why polling, not `fs.watch()`

This project's own primary environment is Android/Termux (`docs/SETUP.md`),
where `fs.watch()`'s inotify backing is genuinely unreliable - scoped
storage, SD cards, and synced folders can miss events outright or fire
duplicates in ways that vary by device and Android version. A one-second
poll costs nothing a human notices for "I just dropped a file" and behaves
identically everywhere - Android, a PC, a network share - rather than
working great on one platform and flaking on the one this project actually
runs on most.

## Why "stopped changing for one poll interval" instead of a real
"write finished" signal

Neither poll-based nor inotify-based watching reliably tells you when a
copy has actually finished across every platform/filesystem combination
this might run on. Comparing a file's size+mtime across two consecutive
polls - only claiming it once a *later* tick sees it byte-for-byte
unchanged from the tick before - is a portable stand-in that doesn't
depend on any platform-specific "close-on-write" event existing at all.
The tradeoff: a multi-gigabyte APK arriving very slowly (a flaky
connection copying it in) could in principle sit at a stable size for a
moment mid-transfer and get claimed early. In practice this hasn't been
an issue - a human manually dropping a file isn't racing a one-second
window - but it's worth knowing if `APK_INBOX_POLL_MS` ever gets set very
low against a very slow transfer.

## What's deliberately simple, and could grow later

- **One `.apk` per claim, no batch/zip support.** Dropping a folder or a
  zip of several APKs does nothing - only files ending in `.apk` are
  noticed at all.
- **A failed claim (a permissions error, a disk-full mid-move) just
  retries on the next poll tick**, with no backoff and no cap - fine for
  how rare that should be, but worth knowing before dropping something
  that reliably fails to claim (it'll log an error every `APK_INBOX_POLL_MS`
  until it's removed or the failure is fixed).
- **The workspace name is derived, not chosen** - there's no way to
  route a specific drop to a specific existing workspace with a
  different name than its filename implies. Rename the file before
  dropping it if you want it to land somewhere specific.
