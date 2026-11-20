---
name: hexforge-apk-triage
description: Full AI-assisted triage of an Android APK with HexForge - fingerprinting, manifest analysis, secret scanning, decompilation and a knowledge-graph-backed assessment with verifiable evidence. Use when asked to analyze, triage or assess an APK.
---

# HexForge APK triage

Drive a running HexForge Gateway (default `http://localhost:8080`, auth via
`HEXFORGE_API_KEY` if enabled) through its REST API. Every step produces a
tracked artifact in the workspace, so the analysis is resumable and the
graph links what it finds.

## 1. Create a workspace

```bash
curl -s -X POST http://localhost:8080/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name": "acme-app-triage"}'
```

Note the `id` in the response; use it as `$WS` below.

## 2. Put the APK where the Gateway can read it

Agents read paths on the Gateway's host (or its shared filesystem). Copy
the APK into the workspace directory - `WORKSPACES_ROOT` is where
workspaces live (default alongside the Gateway checkout, see
`docs/SETUP.md`):

```bash
cp app.apk "$WORKSPACES_ROOT/$WS/"
```

All task payloads below take `apkPath` as an absolute path on the Gateway
host, e.g. `WORKSPACES_ROOT/$WS/app.apk`.

## 3. Triage first (fingerprint + manifest + native inventory)

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "triage", "operation": "assess", "payload": {"apkPath": "<artifact path>"}}'
```

Tasks are fire-and-forget: poll `GET /workspaces/$WS/tasks` until
`status` is `completed`. The assessment reports APKiD fingerprints
(packer/compiler hints), manifest contents (package, SDKs, permissions,
exported components), per-ABI native library inventory and Kotlin
metadata name recovery - in assessment language, with a warnings list for
anything that couldn't run.

## 4. Decompile (feeds the knowledge graph)

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "<artifact path>"}}'
```

When this finishes, the graph already has packages, classes, inheritance
edges, declared methods with call edges, URLs, strings and secret
candidates - no extra step needed.

## 5. Secret scan

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -d '{"agent": "filesystem", "operation": "scan-secrets", "payload": {"targetPath": "<jadx output dir>"}}'
```

Candidates land in the graph as `secret-candidate` entities, redacted -
never the secret value itself.

## 6. Native analysis (optional, for .so files)

Pick a native library from the triage inventory:

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/tasks \
  -d '{"agent": "ghidra", "operation": "analyze", "payload": {"filePath": "<path to .so>"}}'
```

JNI symbols (`Java_com_acme_Foo_bar`) get `maps-to` edges to the Java
methods that declare them `native`.

## 7. Record findings with evidence

Findings must cite real artifacts. Evidence is validated on save - the
cited `file:line` must exist in the workspace's artifacts:

```bash
curl -s -X POST http://localhost:8080/workspaces/$WS/findings \
  -d '{"claim": "App sends device ID to analytics endpoint", "status": "suspected", "confidence": 0.8, "evidence": [{"artifactId": "<id>", "file": "com/acme/Api.java", "line": 42}]}'
```

A finding can't be `confirmed` without validated evidence, and
`GET /findings/:id/verification` re-checks every citation.

## 8. Query the graph

```bash
curl -s "http://localhost:8080/workspaces/$WS/graph/entities?type=secret-candidate"
curl -s "http://localhost:8080/workspaces/$WS/graph/entities?q=acme.com"
```

## Report

`GET /workspaces/$WS/report?format=sarif` for a SARIF report, or read
findings and their verification status directly.
