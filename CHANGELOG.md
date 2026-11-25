# Changelog

Notable changes per release. Everything core (Event Bus, Job/Workflow Engines,
Knowledge Engine, the MCP agents, Auth, AI providers, Terminal chat, MCP Server
Frontend, Plugin System) predates v1.3.27 — see `docs/ARCHITECTURE.md` for the
full picture.

## Unreleased

## 1.10.0 — 2026-11-25
- feat(agents): the `resilience` agent (`resilience.assess`) - instrumentation
  resilience assessment. Composes APKiD fingerprints (for an APK) with a scan
  of a decoded project's smali, Java and native libraries for detection
  idioms across seven categories (frida, xposed, substrate, root, debugger,
  emulator, integrity), each signal citing the file it was seen in. Output is
  a `hardening-assessment` artifact - assessment language ("detected"/"not
  observed"), never a guarantee, so it can back findings without overclaiming.

## 1.9.1 — 2026-11-25
- fix(config): `AUTH_ENABLED=false` in .env no longer silently enables auth
  (strict `true`/`false` parsing instead of `Boolean("false")` coercion).
- fix(graph): one traffic-capture event with malformed percent-encoding no
  longer aborts the whole HAR or JSONL capture; junk events rejected
  (whitespace methods, out-of-range status, negative durations); the
  exactly-max capture no longer logs a spurious truncation warning; traffic
  event names carry the scheme so http/https stay distinct.
- fix(security): the /mcp rate limiter no longer trusts client-controlled
  `X-Forwarded-For` by default (`MCP_HTTP_TRUST_PROXY=true` opts back in
  behind a trusted reverse proxy); the identity map is capped; a NaN
  `MCP_HTTP_RATE_LIMIT_WINDOW_MS` falls back to the default instead of
  bricking every identity at max requests.
- fix(validate): an unterminated comment or CDATA section in a patched XML
  is reported as such instead of misdiagnosing tag nesting.
- fix(graph): method parameters are split on commas at angle-bracket depth
  zero, so `Map<String, String> m` no longer vanishes from call edges.

## 1.9.0 — 2026-11-25
- feat(graph): traffic-capture indexing. A `traffic-capture` artifact (JSONL
  events or a HAR document) becomes `traffic-event` entities in the knowledge
  graph, each mapped with a `maps-to` edge to the `url` entity it hit, so
  runtime requests converge with statically discovered URLs. Redaction by
  design: query parameter names are kept, their values never are; no header
  values or request/response bodies are stored.
- fix(security): the XML well-formedness check's tag scan is now a linear
  character walk (the previous regex was catastrophically backtracking on
  hostile input); audit-log key fingerprints are HMAC-SHA256 with a per-boot
  key; nested generics fully reduce in the calls indexer; the invalid
  AI_PROVIDER error no longer echoes the configured value.

## 1.8.2 — 2026-11-24
- fix(graph): a reflective `invokes` self-edge no longer aborts the whole
  `indexBatch`; filesystem reads are capped for memory.

## 1.8.1 — 2026-11-23
- fix(apktool): gadget injection register bug and relative manifest names.

## 1.8.0 — 2026-11-21
- feat(apktool): `inject-gadget` — embed frida-gadget into a decoded project
  (lib/<abi> + loadLibrary call in the application class, optional
  script-loading config, recorded in patch lineage). Non-root devices get full
  Frida through the normal build/sign/install chain.

## 1.7.1 — 2026-11-20
- docs: roadmap housekeeping.

## 1.7.0 — 2026-11-19
- feat(android): patch -> build -> sign traceability. Patch lineage is recorded
  in `.hexforge-patches.json`; build reports `sha256` + patches; sign reports
  `sourceSha256` and optional `.idsig` (v4 signing).

## 1.6.0 — 2026-11-17
- feat(ai): custom AI providers via `AI_PROVIDERS_PATH` (file-defined providers
  with per-call override, alongside the built-ins) — see `docs/AI.md`.
- feat(storage): Postgres backend (`DATABASE_URL`; Neon free tier documented end
  to end in `docs/SETUP.md`). The storage layer became a `getStorage()` factory,
  so services no longer import specific providers directly.

## 1.5.4 — 2026-11-15
- fix(inbox): containment-checked path resolution for every workspace-derived
  path; fixed error strings in MCP HTTP responses (details go to the server log).

## 1.5.3 / 1.5.2 — 2026-11-14
- fix(security): sanitize inbox paths at the source and stop stream errors from
  reaching clients; CI lockfile points at the public npm registry.

## 1.5.0 — 2026-11-12
- feat(graph): inheritance indexing — `extends`/`implements` clauses become
  `inherits` edges between class entities.

## 1.4.0 / 1.4.1 — 2026-11-10
- feat(runtime): pinned RE toolchain Docker image (jadx 1.5.1, apktool 2.7.0,
  build-tools 34, APKiD 3.2.0, frida-tools 14.13.1, Ghidra 12.2) with a
  one-command health check for every declared backend.

## 1.3.27 – 1.3.29 — 2026-11-08
- feat(secrets): multi-detector secret intelligence with confidence scoring —
  redaction by design (fingerprints and previews, never the value).
- feat(triage): fingerprint-first triage agent (APKiD, manifest, native libs,
  Kotlin metadata name recovery).
- fix(ai): retry and timeout AI provider calls; fixed an MCP SSE reader hang.

## Earlier
Feature history before this point is summarized in `docs/ROADMAP.md` (Done
section) and the docs themselves.
