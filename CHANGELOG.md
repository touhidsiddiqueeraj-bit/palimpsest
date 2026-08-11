# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Monorepo scaffold (pnpm workspaces): `apps/desktop` (Tauri 2 + React 18),
  `packages/core`, `packages/ai`, `packages/mcp`.
- Tauri 2 desktop shell with SQLite plugin; hello-world boots on Linux.
- CI (lint, typecheck, unit tests, MCP conformance, Playwright, build),
  release automation for Linux/macOS/Windows installers, CodeQL, Dependabot.
- Repository documentation: AGENTS.md, CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT, issue/PR templates, MIT license.
- v0 single-file prototype preserved at `reference/v0-single-file-prototype.html`
  as the source of truth for the diff algorithm and UX touches.
