# From artifact to verified evidence

HexForge can turn "I think this app does X" into a claim that points at the
files that show it, and then re-check those files. This page walks the whole
chain once, with `curl` and then with the MCP tools. The pieces are described in
[ARCHITECTURE](ARCHITECTURE.md) ([artifacts](ARCHITECTURE.md#artifacts),
[findings](ARCHITECTURE.md#findings), the [graph](ARCHITECTURE.md#knowledge-graph),
[verification](ARCHITECTURE.md#verifying-evidence)); this is how they fit together.

```
task (jadx) -> artifact (decompiled sources) -> graph entities (classes, packages)
                          \                           /
                           finding: claim + evidence { artifact, entity, location }
                                          |
                                   verification: do the cited places exist?
```

JSON below is abridged: ids are shortened and fields that aren't relevant are left out.

## 0. A workspace

```bash
WS=$(curl -s -X PUT http://localhost:8080/workspaces/by-name/demo \
  -H "Content-Type: application/json" -d '{"targetLabel":"demo"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).id')
```

## 1. Run a task

Tasks run in the background, so dispatching returns straight away and you poll
for the result. jadx needs to be on `PATH` ([AGENTS](AGENTS.md#jadx)).

```bash
curl -X POST http://localhost:8080/workspaces/$WS/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "jadx", "operation": "decompile", "payload": {"apkPath": "/absolute/path/to/app.apk"}}'

curl http://localhost:8080/workspaces/$WS/tasks     # repeat until status is "completed"
```

## 2. The artifact

When the task completes, the Gateway records what it produced:

```bash
curl "http://localhost:8080/workspaces/$WS/artifacts?kind=java-sources"
```

```json
[{
  "id": "Qk3x9...",
  "kind": "java-sources",
  "path": "/.../workspaces/<id>/jadx",
  "pathType": "directory",
  "source": { "agent": "jadx", "operation": "decompile", "capability": "java.decompile" },
  "tools": [{ "tool": "jadx", "version": "1.5.1" }]
}]
```

That `id` is what evidence will cite. `tools` records which jadx produced it.

## 3. The graph

At the same moment the classes and packages in that directory are indexed, with
no extra step:

```bash
curl "http://localhost:8080/workspaces/$WS/graph/entities?type=class&q=login"
```

```json
[{
  "id": "5f1c...",
  "type": "class",
  "name": "com.acme.Login",
  "attributes": { "file": "com/acme/Login.java" },
  "artifactIds": ["Qk3x9..."]
}]
```

If you also ran `decode_apk` (apktool), the same class gains a `smaliFile`
attribute and a second artifact id - it is one entity, not two.
`GET /graph/entities/<id>` adds the edges (the package that contains it, inner
classes).

## 4. Find the evidence

Search the artifact for what you're looking for. A match's `file` is relative to
the directory you searched, which is exactly the form a location takes:

```bash
curl -X POST http://localhost:8080/workspaces/$WS/tasks \
  -H "Content-Type: application/json" \
  -d '{"agent": "filesystem", "operation": "search",
       "payload": {"dirPath": "<artifact path>/sources", "pattern": "http://"}}'
# -> matches: [{ "file": "com/acme/Login.java", "line": 42, "text": "...", "name": "pattern" }]
```

Searching `<artifact path>` itself also works; the locations then start with
`sources/` (`sources/com/acme/Login.java:42`).

## 5. Record the finding

A claim, with each piece of evidence naming the artifact, optionally the entity it
is about, and where:

```bash
curl -X POST http://localhost:8080/workspaces/$WS/findings \
  -H "Content-Type: application/json" \
  -d '{
    "claim": "The login request is sent over cleartext HTTP",
    "confidence": "medium",
    "reasoning": "Login.java builds the URL with an http:// scheme.",
    "evidence": [{
      "artifactId": "Qk3x9...",
      "entityId": "5f1c...",
      "location": "com/acme/Login.java:42",
      "note": "the endpoint URL"
    }]
  }'
```

It is checked when saved: the artifact and the entity must exist in this workspace
and the entity must have been observed in that artifact, and a finding can't be
`confirmed` without evidence. A bad reference comes back as a `400` that says
which one, and nothing is saved:

```json
{ "error": "Evidence cites artifact(s) not found in this workspace: nope" }
```

## 6. Verify it

```bash
curl http://localhost:8080/findings/<findingId>/verification
```

```json
{
  "findingId": "a81d...",
  "summary": "verified",
  "items": [{
    "index": 0,
    "location": "com/acme/Login.java:42",
    "status": "verified",
    "reason": "the file exists and line 42 is within it (210 lines); the entity com.acme.Login exists and was observed in it"
  }]
}
```

Each item is `verified`, `failed` (the file isn't there, the line is past the end,
the entity is gone) or `unverified` (no location, or a single-file artifact such
as a rebuilt APK). The summary is `failed` if anything failed, `verified` if
everything did, `partial` if some verified and the rest couldn't be checked.

## 7. Decide

Verification reports; it never changes the finding. Once you (or the AI, after
reading the code) are satisfied, say so:

```bash
curl -X PATCH http://localhost:8080/findings/<findingId> \
  -H "Content-Type: application/json" -d '{"status": "confirmed"}'
```

`contradicted` is the other end. `GET /workspaces/$WS/findings?status=confirmed`
lists what's settled, and `?entityId=<id>` lists every finding about one class.

## The same flow through MCP tools

| Step | Tool |
|---|---|
| 1. Run the task | `decompile_apk` (or `decode_apk` for smali) |
| 2. See what it produced | `list_artifacts` |
| 3. Look at the graph | `list_graph_entities`, `get_graph_entity` |
| 4. Find the lines | `search_code`, `read_file` |
| 5. Record the claim | `create_finding` |
| 6. Check the citations | `verify_finding` |
| 7. Decide | `update_finding` (status), `list_findings` |

Findings made through MCP are always saved with `source: "ai"`; there is no
parameter to change that. If `create_finding` is rejected, the error names the
bad reference so the model can fix the citation and retry.

## What this does and doesn't tell you

- **It guarantees** that every citation points at something real: the artifact
  exists, the entity exists and was observed there, and the file and line are
  there. Nothing outside the artifact directory is ever read.
- **It does not** tell you the claim is true. `verified` means the cited place
  exists; someone still has to read the code. A finding's status is whatever a
  person or the AI set it to.
- **Some artifacts change under a finding.** `jadx` and `apktool` write to the same
  directory every run, so re-decompiling updates that artifact in place, and a
  location that verified yesterday can fail after a re-run that produced different
  output. Verify again before relying on an old finding. Scan and Frida trace
  results are one file per task and never change.
