# Security Policy

## Reporting a vulnerability

Palimpsest is local-first by design: text, history, and keys stay on your device.
Security issues are taken seriously. **Please do not open a public issue for
security vulnerabilities.**

Report privately by emailing the maintainers at the address listed in the
`SECURITY.md` at the repository root — or, when available, use GitHub's
private vulnerability reporting feature.

You should receive an acknowledgment within 5 business days. We ask that you
allow time to ship a fix before public disclosure.

## Scope

- The desktop app (`apps/desktop`, Rust + WebView)
- `packages/core` (diff, history, renderer, workspace)
- `packages/ai` (provider registry, key handling)
- `packages/mcp` (server and client, audit log, allowlists)

## Hard security commitments

- API keys live only in the OS keychain — never in SQLite, never in logs,
  never in plaintext files.
- The MCP server binds to 127.0.0.1 only, and HTTP transport requires a
  bearer token shown once.
- External MCP tools are never auto-approved; every invocation is audited.
- No telemetry, no analytics, no network calls except those the user
  explicitly triggers (save/export/AI request).
