# HexForge Documentation

## Overview
HexForge is an AI-powered reverse engineering workspace designed to analyze, decompile, and understand compiled applications. It integrates AI, MCP (Model Context Protocol) agents, and developer tooling into a unified system for structured analysis of software binaries.

The goal of HexForge is not to modify or bypass software protections, but to provide a professional environment for understanding application structure, behavior, and architecture.

---

## Core Purpose
HexForge exists to:

- Analyze compiled applications (e.g. Android APKs)
- Decompile and inspect source code using tool-assisted pipelines
- Provide AI-driven explanations of code and system behavior
- Maintain persistent knowledge of analyzed projects
- Coordinate local tooling through MCP agents
- Build structured reverse engineering reports

---

## High-Level Architecture

HexForge is composed of distributed components:

```
User Interface (Web / Mobile)
        │
        ▼
HexForge Gateway (Core API Layer)
        │
        ├── Supabase (Database + Knowledge Engine)
        ├── AI Layer (LLM providers or local models)
        ├── MCP Orchestrator
        │        ├── APKTool Agent
        │        ├── JADX Agent
        │        ├── Frida Agent
        │        ├── ADB Agent
        │        └── File System Agent
        │
        ▼
Local MCP Runtime (Execution Environment)
```

---

## System Components

### 1. HexForge Gateway
The central backend service responsible for:

- Managing user requests
- Creating and tracking workspaces
- Dispatching tasks to MCP agents
- Handling WebSocket communication
- Managing AI interactions
- Coordinating job execution pipelines

---

### 2. MCP Agent Layer
MCP agents are local executors that perform heavy operations without uploading large files.

Responsibilities:

- Running APKTool for decompilation
- Using JADX for Java/Kotlin reconstruction
- Executing Frida for runtime analysis
- Accessing local file systems directly
- Processing large binaries locally

Key benefit:
No need to upload large APK files to the cloud.

---

### 3. Supabase (Knowledge Engine)
Supabase acts as the persistent brain of HexForge.

It stores:

- User accounts
- Workspaces
- Chat history
- Analysis reports
- Task metadata
- Embeddings (vector search for semantic retrieval)

This enables AI memory and project continuity.

---

### 4. AI Layer
The AI layer interprets results from MCP agents and provides:

- Code explanations
- Architecture analysis
- Behavior summaries
- Security pattern detection
- Report generation
- Query-based search over analyzed code

AI does not directly process files; it interprets structured outputs.

---

### 5. Web Application (HexForge Web)
A developer IDE-style interface providing:

- Workspace explorer
- Decompiled code viewer
- AI chat interface
- Report dashboards
- Search and navigation tools
- Real-time analysis updates

---

### 6. Mobile Application (HexForge Mobile)
A companion app for:

- Viewing analysis progress
- Accessing reports and chat history
- Monitoring workspace activity
- Remote triggering of tasks

---

## Workspace System

Each project is isolated in a workspace.

A workspace contains:

- Decompiled code index
- Analysis reports
- AI chat history
- Task execution logs
- Notes and annotations
- Vector embeddings

Example structure:

```
workspace_id/
    reports/
    jadx/
    smali/
    memory.db
    chat_history.db
```

---

## Core Workflow

1. User uploads or references an application
2. Gateway creates a workspace
3. MCP agent decompiles the application locally
4. Results are indexed and stored in Supabase
5. AI analyzes structured outputs
6. User interacts via chat or IDE interface
7. System builds persistent knowledge over time

---

## Data Flow Model

```
User Request
    ↓
Gateway API
    ↓
Task Dispatcher
    ↓
MCP Agent (Local Execution)
    ↓
Structured Output
    ↓
Supabase Storage
    ↓
AI Processing Layer
    ↓
User Response
```

---

## Scalability Design

HexForge is designed to scale horizontally:

- Multiple MCP agents can run on different machines
- Gateway can distribute tasks across agents
- Supabase handles centralized persistence
- AI providers can be swapped or extended
- Web and mobile clients are stateless

---

## Security Considerations

- No mandatory upload of large binaries
- Workspace isolation between projects
- Encrypted API keys in database
- Optional local-only mode (no cloud dependency)
- Controlled execution of MCP tools

---

## Future Expansion

Planned enhancements:

- Plugin system for MCP agents
- Collaborative multi-user workspaces
- Advanced call graph visualization
- Automated patch generation suggestions
- Offline-first local mode
- Custom AI agent pipelines

---

## Naming Conventions

- hexforge-gateway → Core backend
- hexforge-web → Web IDE
- hexforge-mcp → Local tool system
- hexforge-agent → Execution runtime
- HexForge AI → Optional assistant layer

---

## Summary

HexForge is a modular AI-assisted reverse engineering platform that combines local execution, structured knowledge storage, and AI reasoning into a unified system for software analysis.

It is designed to be scalable, extensible, and developer-focused.
