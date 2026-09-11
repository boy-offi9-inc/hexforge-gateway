# Security Policy

## Supported Versions

HexForge Gateway is a solo-maintained project without a formal LTS
policy yet. Security fixes are applied to the latest release on `main`.
If you're running an older tagged version, please update before
reporting an issue that may already be fixed.

## Reporting a Vulnerability

Please **do not open a public GitHub issue** for security
vulnerabilities - that discloses the problem to everyone, including
anyone who might exploit it, before a fix exists.

Instead, report privately via one of:

- **GitHub Private Vulnerability Reporting**: open the [Security tab](../../security/advisories/new)
  on this repo and click "Report a vulnerability" (preferred - keeps
  the whole conversation and any patch in one place).
- **Email**: hello@boy-offi9-inc.my.id

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is genuinely the fastest path
  to a fix)
- Which endpoint, agent, or module is affected

### What to expect

This is a solo-maintained project, not a company with an SLA - please
expect an initial response within about a week, not 24 hours. I'll
acknowledge the report, work on a fix, and credit you in the fix's
release notes unless you'd rather stay anonymous.

## Scope Notes

A few things that are **intentional design tradeoffs for a
self-hosted, local-first tool** rather than vulnerabilities, so you
don't need to report them (though feedback on the tradeoff itself is
welcome as a regular issue):

- **Auth is off by default** (`AUTH_ENABLED=false`). HexForge Gateway
  is meant to run on your own machine or device (Termux, a home
  server) behind your own network boundary, not exposed to the
  internet. If you do expose it beyond localhost, set `AUTH_ENABLED=true`
  and configure `API_KEYS` first - the Gateway warns loudly at startup
  if you don't.
- **The MCP server frontend trusts its stdio client.** It's designed
  to be launched by a local MCP client (Claude Desktop, Claude Code)
  that already has full access to your machine - it is not a network
  service and does not authenticate callers.
- **Agents shell out to real tools** (jadx, apktool, adb, frida,
  APKiD) with the task payload's arguments. This project is a
  reverse-engineering *workspace*, not a sandboxed multi-tenant
  service - anyone with API access already has the same capabilities
  those tools have on your machine. Don't expose an unauthenticated
  Gateway to untrusted callers.

If you find a way to escape a *workspace's own* directory sandboxing
(see the filesystem agent's write/delete path checks) or bypass
`AUTH_ENABLED` when it's actually configured, that's a real
vulnerability and worth a private report.
