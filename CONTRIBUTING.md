# Contributing to HexForge Gateway

## Before you start

Read the README, specifically: [Getting started](README.md#getting-started),
[Project layout](README.md#project-layout), and whichever feature area
you're touching - each engine/agent/provider has its own section with the
design rationale, not just usage docs.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

Works with zero external services out of the box (`STORAGE_BACKEND=local`,
no AI provider required to boot).

## Before opening a PR

```bash
npm run typecheck
npm run build
./scripts/smoke-test.sh   # against a running `npm run dev`/`npm start` instance
```

CI (`.github/workflows/ci.yml`) runs all three automatically, plus a
handshake check on the MCP server frontend - but running them locally
first saves a round trip. `smoke-test.sh` gracefully skips anything that
needs external hardware/binaries you might not have (jadx, apktool, adb,
frida, a configured AI provider) rather than failing, so it's safe to run
with a minimal local setup.

## The two most common ways to extend this

**Adding a new tool integration (a new MCP agent):** see
[MCP agents](README.md#mcp-agents) for the pattern every existing one
follows (`execFileAsync` + `friendlyExecError` from
`modules/mcp/agents/shared/exec-error.ts` for anything that shells out to
a CLI tool), then register it in `modules/mcp/orchestrator.ts`. If it's
something you don't want in core (a niche tool, something with unusual
dependencies), the [Plugin System](README.md#plugin-system) is very
likely the better fit - `plugins/installed/example-strings/` is a
complete, working template.

**Adding an AI provider:** if it speaks the OpenAI Chat Completions shape
(most do), it's a ~10-line addition reusing
`completeWithOpenAiCompatibleShape` in `providers/ai.provider.ts` - see
any of `completeWithGroq`/`completeWithDeepseek`/`completeWithXai` for
the pattern. Verify the actual current base URL and a sensible default
model via the provider's own docs before hardcoding anything - several
providers in this file deprecated their old default model names during
this project's own development, which is exactly the kind of thing worth
double-checking rather than assuming from memory.

## Code style

No linter/formatter configured yet (see Roadmap) - match the existing
style in whichever file you're editing. Comments should explain *why*,
not restate *what* the code already says - and if you're changing
behavior a comment describes, update or remove that comment in the same
change. A stale comment claiming something "isn't built yet" when it is
is worse than no comment at all.

## Reporting issues

Include what you ran, what you expected, what happened instead, and the
output of `GET /health` if it's Gateway-related (shows active storage
backend, AI provider, and auth status without you having to describe your
`.env`).
