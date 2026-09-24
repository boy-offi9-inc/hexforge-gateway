# HexForge Gateway

<p align="center">
  <img src="https://i.ibb.co/LD4QQ068/file-000000000c2881f499f01543e6d22f8c.png" alt="HexForge Gateway" width="360">
</p>

<p align="center">
  <a href="https://github.com/boy-offi9-inc/hexforge-gateway/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/boy-offi9-inc/hexforge-gateway/ci.yml?branch=main&style=for-the-badge&label=CI&logo=githubactions&logoColor=white&color=0EA5E9" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-7B2FF7?style=for-the-badge&logo=opensourceinitiative&logoColor=white" alt="MIT License"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node >= 20"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-5.5-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://fastify.dev"><img src="https://img.shields.io/badge/Fastify-5-000000?style=for-the-badge&logo=fastify&logoColor=white" alt="Fastify"></a>
  <br>
  <a href="docs/SETUP.md"><img src="https://img.shields.io/badge/runs%20on-Termux%20%7C%20PC-0EA5E9?style=for-the-badge&logo=termux&logoColor=white" alt="Runs on Termux or PC"></a>
  <img src="https://img.shields.io/badge/cloud-optional-7B2FF7?style=for-the-badge&logo=icloud&logoColor=white" alt="Cloud optional">
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-FF4785?style=for-the-badge&logo=github&logoColor=white" alt="PRs welcome"></a>
</p>

AI-assisted APK reverse-engineering workspace API. Dispatches tasks to
MCP agents (jadx, apktool, adb, frida, filesystem, MT Manager's APK MCP,
AI providers) and streams updates over WebSocket. Runs entirely on-device
(Termux + MT Manager on Android) or on a normal PC - no cloud required.

Flow: `Workspace -> Workflow -> Jobs -> Tasks -> MCP Agents`, with modules
talking through an Event Bus. MIT licensed. Contributing: run
`npm run typecheck && npm run build && ./scripts/smoke-test.sh` before a
PR - see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Getting started

```bash
npm install
cp .env.example .env
npm run dev
```

The Gateway starts on `http://localhost:8080` and prints a banner with your
workspaces and copy-pasteable commands. `GET /` returns the same as JSON -
the quickest way to see what's here.

Core endpoints (request/response shapes are in the linked docs):

- `GET /` - live cheat sheet - `GET /health` - service + config status
- `POST /workspaces` / `GET /workspaces[/:id]` / `PUT /workspaces/by-name/:name` (idempotent get-or-create)
- `POST /workspaces/:id/tasks` - dispatch to an MCP agent, fire-and-forget; poll or watch `/ws` ([AGENTS](docs/AGENTS.md))
- `POST /workspaces/:id/jobs` / `/workflows` / `/knowledge` ([ARCHITECTURE](docs/ARCHITECTURE.md))
- `POST|GET /workspaces/:id/chat` ([AI](docs/AI.md))
- `GET /plugins` ([PLUGINS](docs/PLUGINS.md))
- `WS /ws` - real-time `task:update`, `job:update`, `workflow:update`, `knowledge:entry_created`, `workspace:status_changed`

## Stack

Node.js 20+ / TypeScript, Fastify (+ `@fastify/websocket`), Zod. Storage is
local files by default; Supabase is opt-in (`STORAGE_BACKEND=supabase`). Auth
is an opt-in API key check, off by default (`AUTH_ENABLED=false`).

## Documentation

| Doc | Covers |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Requirements, auth, storage backend, running on PC and Android/Termux |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Event Bus, Job Engine, Workflow Engine, Knowledge Engine |
| [`docs/AGENTS.md`](docs/AGENTS.md) | Every MCP agent - operations and examples |
| [`docs/AI.md`](docs/AI.md) | The AI provider layer (9 providers), the `ai` agent, Terminal chat |
| [`docs/MCP_SERVER.md`](docs/MCP_SERVER.md) | Registering HexForge's agents as native tools in Claude Desktop/Code/Cursor |
| [`docs/PLUGINS.md`](docs/PLUGINS.md) | The Plugin System - contract, loader, reference plugins |
| [`docs/CLI.md`](docs/CLI.md) | `scripts/hf.sh` and `scripts/smoke-test.sh` |
| [`docs/MT_MANAGER.md`](docs/MT_MANAGER.md) | MT Manager's APK MCP setup, with screenshots and troubleshooting |
| [`docs/PROJECT_STRUCTURE.md`](docs/PROJECT_STRUCTURE.md) | Repo layout and how the pieces talk |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | What's done and what's still open |
