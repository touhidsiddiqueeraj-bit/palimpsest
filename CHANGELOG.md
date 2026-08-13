# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Full project documentation: `README.md` (features, media, MCP setup),
  `docs/ARCHITECTURE.md` (capability layer, file-first storage, MCP spine),
  `docs/VERIFICATION.md` (reproducible live proof: stdio, HTTP, opencode),
  media under `docs/media/` (editor + v0 screenshots, architecture SVG,
  live verification transcript).
- README: PolyForm Noncommercial 1.0.0 license badge; license change from
  MIT to non-commercial use (see LICENSE).
- Desktop: configurable AI provider — server URL, model, and API key are set
  in a Settings panel (URL/model persisted; key kept in memory only, never
  stored). Provider selection no longer assumes Ollama on localhost; friendly
  connection errors point at the Settings panel. AI remains fully optional:
  the editor/history/diff flows never require a provider.
- Desktop: palimpsest logo — layered-pages mark (ink, paper slats, amber
  milestone dot) at all icon sizes; regenerable via `scripts/make-logo.py`.

### Fixed

- Desktop: app crash on first run — "unable to open database file". The
  workspace directory is now created before the SQLite database opens, and the
  workspace path is resolved to an absolute path inside the app-data dir so
  the `$HOME/**` fs scope accepts it ("forbidden path" no longer occurs).

### Changed

- License: MIT → **PolyForm Noncommercial 1.0.0** — free for personal,
  research, educational, and noncommercial-organization use; commercial use
  requires a separate license.

### Removed

- Root `postinstall` script (ran before root bins were linked in CI);
  build the MCP CLI bundle explicitly with `pnpm --filter @palimpsest/mcp build:cli`.

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
- CodeMirror 6 editor (markdown lang, history, Mod-b/i/k shortcuts) with
  live source + preview split.
- History drawer: time-scrubber, kind filter chips, milestone rename
  (double-click, frontmatter-only), gone/changed status chips.
- Diagram code fences (ditaa, mermaid, …) render to SVG on demand via kroki —
  requests flow through the netguard so Local-only blocks them visibly.
- Import/export: regex HTML↔markdown (`Alt+L` export, `Ctrl+Shift+I` import).
- BYOK AI package: provider registry (Ollama / LM Studio / OpenAI-compatible),
  protocol adapters, client-level Local-only gate; keys sent only to remote
  providers. `inlineEdit` proposes a full document and returns a word diff —
  the AI never writes.
- Desktop "Ask AI" panel: propose → review diff counts → accept/reject;
  accepting captures an `ai` snapshot recording model + instruction
  (auto-milestone per product law 4).
- Chat tab: "recall recent writing" injects status-annotated history context
  from `store.recall`, answers stream into the panel; per-session usage meter.
- MCP server package (`packages/mcp`): capability-layer tools (recall,
  get_outline, get_document, get_stats, create_milestone, restore_version,
  apply_edit) over the same core API as the UI — no duplicated logic. Every
  response carries `tokens_used`; every mutator accepts `dry_run`. stdio
  transport via `createMcpServer()` / `runStdioServer()`.
- Conformance suite (vitest 4): 7 tests green in CI gate.
- MCP client: per-tool allowlists + write-through audit log (denied calls are
  recorded too); durable file sink via `PALIMPSEST_AUDIT`.
