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
- Plan + canonical spec: `PLAN.md`, `docs/PALIMPSEST_MASTER_PROMPT.md`.
- Markdown renderer (GFM tables/task lists, callouts, footnotes, wikilinks,
  math, sanitized links) with AST; word-level diff engine with progress
  reporting; both covered by fixture/golden suites.
- **File-backed history** (spec v2): immutable snapshot `.md` files with YAML
  frontmatter under `.palimpsest/snapshots/` as source of truth; SQLite/FTS5
  `index.db` is a derived, rebuildable index (`reindex()`); pruning moves
  retired auto/system snapshots to `.palimpsest/archive/`
- Context-budget-aware `recall(query, budget)` returning ranked memory bundles
  (current/deleted/modified status); FTS search with `include_deleted`.
- Snapshot list rows expose `status` (current/modified/deleted vs current text);
  milestone labels are renameable via `renameSnapshot` without touching the
  document text.
- Desktop history drawer (M2): time-scrubber over snapshots with preview +
  one-click restore; per-snapshot changed/gone indicators.
- Network transparency layer: outbound requests — fetch/XHR/WebSocket — light a
  status indicator with destination host; hard "Local-only" toggle blocks every
  non-localhost request at the wrapper. No logging.
- Tauri adapters bridging `packages/core` (SqliteDb, SnapshotFs) to
  `tauri-plugin-sql` / `tauri-plugin-fs`; fs scope is `$HOME/**`.
