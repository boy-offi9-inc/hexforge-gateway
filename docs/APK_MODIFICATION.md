# Modifying an APK

The loop is **decode -> patch -> rebuild -> sign -> install**. HexForge does each
step, tracks what changed, and keeps the results as [artifacts](ARCHITECTURE.md#artifacts)
you can cite from a [finding](EVIDENCE.md).

Only modify and install apps you own or are authorized to modify. Editing,
re-signing and installing someone else's app can break their terms, and apps that
check their own signature will refuse to run once it changes.

This is the small version of the job: exact-text edits to a decoded project, then
rebuild, sign and install. It doesn't edit the binary resource table, handle split
APKs or XAPK bundles, or sign with your own key. For heavier edits, MT Manager's own
tools are reachable through [`apkmcp`'s `call_tool`](MT_TOOLS.md).

## What you need

| Tool | Used for | On Termux |
|---|---|---|
| `apktool` | decode and rebuild | `pkg install apktool` |
| `apksigner` | signing | `pkg install apksigner` (the Android SDK's works too) |
| `zipalign` | aligning before signing (SDK `apksigner` only) | comes with `pkg install aapt`; check with `command -v zipalign` |
| `keytool` | generating the debug key (SDK `apksigner` only) | `pkg install openjdk-17` |
| `adb` | installing | `pkg install android-tools` |

Two different programs are both called `apksigner`: the Android SDK's
(`apksigner sign --ks ...`) and the lightweight one Termux's package installs
(`apksigner [-p password] keystore in out`). The `sign` operation tells them apart by
asking for `--version`, which only the SDK one answers, and you can force the choice
with `"flavor": "sdk"` or `"lite"` if it guesses wrong.

## 1. Decode

```bash
WS=<workspaceId>
curl -X POST http://localhost:8080/workspaces/$WS/tasks -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "decode", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'
```

The result's `outputDir` is the decoded project (smali, `AndroidManifest.xml`,
resources). It is recorded as an `apktool-project` artifact, and its smali classes go
into the [graph](ARCHITECTURE.md#knowledge-graph). **Decoding again replaces this
directory, so any patches in it are lost** - patch after the decode you mean to keep.

## 2. Patch

Replace exact text in one file. It fails rather than guess: the text has to be found,
and has to match once unless you set `"all": true`.

```bash
curl -X POST http://localhost:8080/workspaces/$WS/tasks -H "Content-Type: application/json" -d '{
  "agent": "apktool", "operation": "patch",
  "payload": {
    "projectDir": "<outputDir from decode>",
    "file": "AndroidManifest.xml",
    "find": "android:debuggable=\"false\"",
    "replace": "android:debuggable=\"true\""
  }
}'
```

`file` is relative to the project (`smali/com/acme/Login.smali`). Paths that leave the
project, symlinks that lead out, binary files and files over 5 MB are refused. Each
patch saves a record (what it replaced, which lines, and SHA-256 hashes of the file
before and after) as an `apk-patch` artifact: `GET /workspaces/$WS/artifacts?kind=apk-patch`.
The record holds no machine paths. Patches are applied in place, one file at a time;
run several to change several files.

## 3. Rebuild

```bash
curl -X POST http://localhost:8080/workspaces/$WS/tasks -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "build", "payload": {"inputDir": "<projectDir>"}}'
```

`outputPath` is the rebuilt APK (an `apk` artifact). It is **unsigned** and won't
install yet.

## 4. Sign

```bash
curl -X POST http://localhost:8080/workspaces/$WS/tasks -H "Content-Type: application/json" \
  -d '{"agent": "apksigner", "operation": "sign", "payload": {"apkPath": "<outputPath from build>"}}'
```

It aligns (SDK flavor) and signs with a **debug key** generated on first use and kept
in the Gateway's data directory, then checks the signature (SDK flavor). The signed
copy lands in `WORKSPACES_ROOT/<id>/apksigner/signed/` as a `signed-apk` artifact, and
the result's `apkPath` is what `adb install` reads. `schemes` lists the signature
schemes that verified (`v1`, `v2`, `v3`); `warnings` says anything that was skipped,
such as no `zipalign` on the machine.

Because the key is new, the signature is **not the original app's**. That has two
consequences. The result isn't something to distribute. And Android won't install it over
the original: uninstall that first (`adb shell pm uninstall <package>`, which also
deletes its data).

## 5. Install

```bash
curl -X POST http://localhost:8080/workspaces/$WS/tasks -H "Content-Type: application/json" \
  -d '{"agent": "adb", "operation": "install", "payload": {"apkPath": "<apkPath from sign>"}}'
```

## All of it as one workflow

A step with `mergePreviousResult` receives the previous step's result, which is why
the later steps need no paths:

```bash
curl -X POST http://localhost:8080/workspaces/$WS/workflows -H "Content-Type: application/json" -d '{
  "name": "Patch and install",
  "steps": [
    { "agent": "apktool", "operation": "decode", "payload": { "apkPath": "/absolute/path/to/app.apk" } },
    { "agent": "apktool", "operation": "patch", "mergePreviousResult": true,
      "payload": { "file": "AndroidManifest.xml", "find": "android:debuggable=\"false\"", "replace": "android:debuggable=\"true\"" } },
    { "agent": "apktool", "operation": "build", "mergePreviousResult": true },
    { "agent": "apksigner", "operation": "sign", "mergePreviousResult": true },
    { "agent": "adb", "operation": "install", "mergePreviousResult": true }
  ]
}'
```

Add more `patch` steps before the build. If the app is already installed under its
original signature, the install step fails; uninstall it first.

## The same through MCP tools

| Step | Tool |
|---|---|
| Decode | `decode_apk` |
| Patch | `patch_apk_project` |
| Rebuild | `build_apk` |
| Sign | `sign_apk` |
| Install | `adb_install` |

`patch_apk_project` is flagged destructive, since it edits the decoded project in
place. `sign_apk` is not.

## Recording what you changed

The patch records and the signed APK are artifacts, so a finding can point at them
("the patched manifest sets debuggable") the same way it points at decompiled sources.
[`verify_finding`](EVIDENCE.md) can't check a line inside a single-file artifact like a
signed APK or a patch record, so such evidence is reported `unverified`: the artifact
exists, and the hashes in the patch record are what pin down the change.
