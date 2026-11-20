# HexForge Skills Pack

Ready-to-use skill files for Claude Code and compatible agent CLIs. Each
`skills/<name>/SKILL.md` drives a real HexForge workflow against a running
Gateway - skills are the distribution layer, MCP is the protocol, HexForge
is the execution and state layer behind both.

| Skill | Drives |
|---|---|
| [`hexforge-apk-triage`](hexforge-apk-triage/SKILL.md) | Full analysis: triage, decompile, secrets, native (Ghidra), findings with verified evidence, graph queries, SARIF |
| [`hexforge-apk-patch-rebuild`](hexforge-apk-patch-rebuild/SKILL.md) | Decode -> patch -> rebuild -> align -> sign -> verify, every step artifact-tracked |
| [`hexforge-mcp-server`](hexforge-mcp-server/SKILL.md) | Register HexForge's agents as native tools in Claude Desktop / Claude Code / Cursor (stdio or HTTP) |

## Install

Copy the skill directories you want into your client's skills location
(for Claude Code: `.claude/skills/` in the project or `~/.claude/skills/`
globally):

```bash
cp -r skills/hexforge-apk-triage ~/.claude/skills/
```

The skills talk to a running HexForge Gateway - see `docs/SETUP.md` to
start one, or `Dockerfile.runtime` for the pinned one-command runtime.
