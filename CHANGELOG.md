# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Desktop: open any `.md` from the file manager — "Open with…", double-click,
  or `palimpsest <file>`. The OS registration ships in the installers
  (`palimpsest.desktop`: `MimeType=text/markdown;text/x-markdown;`,
  `Categories=Utility;TextEditor;`, `Exec=palimpsest %F`), and the last
  workspace is persisted (`workspace.txt`) so a no-argument launch reopens
  your documents.
- Desktop: external edits are captured before a document opens (reconcile) —
  changes made by other editors, git, or agents become snapshots instead of
  being silently adopted. Workspace access now allows the `.palimpsest`
  history tree explicitly (Tauri's recursive `dir/**` glob never matches
  dot-directories, so the history dir was previously a "forbidden path" and
  boot could silently fail on a fresh machine).
- MCP: `create_milestone` never silently discards the request — an unchanged
  doc gets the milestone label attached to its latest snapshot
  (`{snapshot_id, reused_snapshot:true}`) instead of a success-shaped no-op
  that agents misreport as done; external file edits are still captured as
  auto snapshots when a doc is opened or a milestone is requested
  (documented in `--help`).
- Desktop: workspaces are scanned recursively — `.md` files in subfolders
  (shown as `folder/name.md`) now appear in the Docs list, and the list
  re-scans every 5 seconds so files created by agents or other editors show
  up without a restart. Dot-directories (`.palimpsest`, `.git`), hidden files
  and build/dependency dirs (`node_modules`, `dist`, `target`, …) stay out of
  the list. The single `.palimpsest` history folder stays at the workspace
  root; snapshot storage is unchanged.
- Desktop: the Docs "new file" field accepts `subfolder/name.md` and creates
  the parent folder, matching what agents can already do via the MCP server.
- MCP: `create_doc` creates the parent directory for nested names, and the
  CLI now shares the same recursive Markdown walker as the desktop app
  (`packages/core`), so both surface identical document sets.

### Changed

- Desktop: UI refinish — panes separate by whitespace instead of border
  rules (the only remaining seam is editor→preview); one accent color
  (orange) reserved for a single primary action per view (Accept, Save,
  active segment); markdown links render neutral; toolbar rebuilt as
  lucide icons grouped into format/insert/block clusters; editor headings
  scale 1.55→1.0em and metadata is smaller with tabular numerals; history
  list gets a git-log timeline spine with hue-family dots; history drawer
  (and Ask AI) now collapsed by default — expand via the rail.

### Fixed

- Desktop: first-launch/double-click boot bug — the open handler closed over
  a pre-boot (null) store and silently skipped reconcile, leaving the opened
  document without its snapshot history. The handler now reads the store via
  a ref that is populated when the workspace opens.
- Desktop: split view — removed the Edit/Preview pane-toggle buttons from
  the formatting toolbar (clicking "Preview" collapsed the preview pane,
  reading as a broken split); split is a plain two-column layout again, with
  the invisible drag-resize divider.
- MCP: `smoke.mjs` updated for the label-latest milestone contract — the
  manual smoke (13 checks) is green again against the bundled CLI.

- MCP: document names accept with or without the `.md` suffix across every
  tool (`create_doc("X")` now pairs with `get_document("X")` / `apply_edit("X")`
  / `get_stats("X")`); missing names always error as
  `document not found: X (create it with create_doc)`.
- MCP: `get_stats` no longer silently falls back to the first `.md` in the
  workspace when an explicit doc name does not resolve — it errors. Without a
  `doc` argument it defaults to `notes.md` (or the first `.md`) and names the
  measured document in the response.
- MCP CLI: `--help` documents doc-name forms and the `get_stats` default.
- MCP: `apply_edit` agent-supplied path — with local-only off
  (`PALIMPSEST_LOCAL_ONLY=0`) and no provider URL, the tool accepts a full
  `content` replacement: the word diff is computed, a before-snapshot is
  captured, and a milestone records `model: "agent"` + instruction. While
  local-only is on, `apply_edit` requires a local provider and refuses with
  an actionable message.
- MCP CLI: `localOnly` is now wired from `PALIMPSEST_LOCAL_ONLY` (was
  hardcoded on); `--help` documents the toggle and `apply_edit` semantics.
- MCP CLI: published as `palimpsest` on PATH via a `bin` field +
  `pnpm link --global` (rebuild-safe through a `prepare` script).
- MCP: `create_doc` overwrite — `content` on an existing document requires
  `overwrite:true`, which snapshots the current state before replacing it
  (no more silent `created:false` for agents).
- MCP: `create_doc` tool — create a `.md` file in the workspace, register it
  with history, and seed its first snapshot. Idempotent (returns the existing
  doc on a name collision); no AI provider required. Missing-document errors
  now point at `create_doc`.
- MCP CLI: `--help` / `--version` flags (previously swallowed — the stdio
  server started and blocked, so `--help` hung). Declared `esbuild` as a
  devDependency (build script referenced it but it was never installed).
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
