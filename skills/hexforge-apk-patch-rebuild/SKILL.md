---
name: hexforge-apk-patch-rebuild
description: Decode, patch, rebuild, align, sign and verify an Android APK with HexForge's apktool/apksigner agents. Use when asked to modify an APK, change its manifest or resources, or rebuild and re-sign a decoded project.
---

# HexForge APK patch → rebuild → sign

Requires a running HexForge Gateway (`http://localhost:8080`) with the
pinned runtime (`Dockerfile.runtime`) or apktool/apksigner/zipalign on its
host. Every step writes its artifact under `WORKSPACES_ROOT/<workspaceId>/`,
so the chain is resumable and every artifact is linked to the exact task
that produced it.

## 1. Workspace + decode

```bash
curl -s -X PUT http://localhost:8080/workspaces/by-name/acme-patch \
  -H "Content-Type: application/json" -d '{}'
# (PUT by-name reuses the workspace across sessions; POST /workspaces also works)

curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "apktool", "operation": "decode", "payload": {"apkPath": "/abs/path/app.apk"}}'
```

Poll `GET /workspaces/$WS/tasks` until `completed`; the result carries the
decoded project directory.

## 2. Patch

Smali or resources, one patch per task, each recorded with what changed:

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -d '{"agent": "apktool", "operation": "patch", "payload": {"projectDir": "<decode output dir>", "file": "AndroidManifest.xml", "find": "debuggable=\"false\"", "replace": "debuggable=\"true\""}}'
```

`file` is relative to the project; string resources, smali constants and
manifest attributes all work the same way.

## 3. Rebuild

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -d '{"agent": "apktool", "operation": "build", "payload": {"projectDir": "<decode output dir>"}}'
```

## 4. Align + sign

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -d '{"agent": "apksigner", "operation": "sign", "payload": {"apkPath": "<rebuilt apk>"}}'
```

The signed copy lands at
`WORKSPACES_ROOT/<workspaceId>/apksigner/signed/<name>-signed.apk`.

## 5. Verify

- `triage` on the signed APK should report the patched manifest values.
- `adb install` (`{"agent": "adb", "operation": "install", "payload": {"apkPath": "<signed apk>"}}`)
  against a connected device for a live check.

## What NOT to do

- Don't write outside `WORKSPACES_ROOT/<workspaceId>/` - agents reject it.
- Don't skip alignment before signing; apksigner refuses misaligned APKs.
