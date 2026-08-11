# HexForge Architecture v2

## Vision
HexForge is an AI-assisted reverse engineering platform built around a modular gateway and local MCP agents. The platform orchestrates tools, preserves project knowledge, and provides an IDE-like experience.

## Why We Changed the Architecture

Initial flow:
Workspace → Task → MCP Agent

New flow:
Workspace → Workflow → Jobs → Tasks → MCP Agents

This enables retries, scheduling, plugins, AI providers, and better scalability.

## High-Level Architecture

User (Web/Mobile)
    |
HexForge Gateway
    |
+-- API
+-- Event Bus
+-- Workflow Engine
+-- Job Scheduler
+-- Knowledge Engine
+-- MCP Manager
    |
Local MCP Agents
(APKTool, JADX, Frida, ADB)

## Project Structure

hexforge-gateway/
- src/
  - api/v1/
  - core/
  - modules/
    - workspace/
    - workflow/
    - jobs/
    - mcp/
    - ai/
    - knowledge/
    - auth/
  - providers/
  - plugins/
  - events/
  - queues/

## Key Components

### Workflow Engine
Coordinates complete operations like "Analyze APK".

### Job Engine
Breaks workflows into retryable jobs:
- Extract manifest
- Decompile
- Index source
- Generate embeddings
- AI summary

### Event Bus
Modules communicate through events rather than direct calls.

### Knowledge Engine
Stores:
- Chats
- Reports
- Notes
- Embeddings
- Relationships
- Summaries

### MCP Manager
Delegates work to local MCP agents. The gateway never performs heavy analysis itself.

### Provider Layer
Abstracts Supabase, AI providers, Redis, and future integrations.

### Plugin System
Allows official and community extensions without changing the core.

## Data Flow

1. User starts workflow.
2. Gateway creates jobs.
3. Scheduler dispatches jobs.
4. MCP agents execute locally.
5. Results are indexed.
6. Knowledge Engine updates memory.
7. AI generates insights.
8. WebSocket streams progress.

## Principles

- AI decides; MCP executes.
- Local-first for large files.
- Persistent workspace knowledge.
- Modular, scalable architecture.
