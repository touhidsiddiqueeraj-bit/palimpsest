# PLAN.md — Palimpsest

> "The Markdown editor that remembers — so your AI can too."
> Word-level time travel: automatic snapshots, named milestones, prose-aware diffs.
> AI edits arrive as reviewable word diffs, never silent rewrites.

Companion: `docs/PALIMPSEST_MASTER_PROMPT.md` (the full spec). This file decomposes the spec into milestones, each with tasks and acceptance checks. Ship M0 → M5 in order; never push a failing milestone. Conventional Commits; CHANGELOG per PR.

## Product laws (non-negotiable, from spec §2)

1. File-first — source of truth is plain `.md` on disk.
2. Local & private by default.
3. The diff is the primitive — all revision features flow through one word-level diff engine.
4. AI proposes, the diff decides — AI edits are previewed as word diffs, require explicit accept/reject; accepting creates an auto-milestone recording model + instruction.
5. Human/AI parity — every AI capability reachable by human UI/shortcut; every core human action reachable by an agent via MCP.
6. Model-agnostic, BYOK — keys in OS keychain only; every AI feature must work with a local model (Ollama / LM Studio / polaris studio) and zero network calls.
7. No telemetry, no analytics, no dark patterns. Ever.
8. Every token counts — agent retrieval is budget-aware; responses report `tokens_used`.

## Architecture (capability layer)

Document/history operations are implemented once in `packages/core` as a typed capability API. The app UI, the chat tool-caller, and the MCP server all consume that same API. Never duplicate logic in the UI, chat tools, or MCP tools.

**History model (§4.3):** each snapshot is a full immutable Markdown file with YAML frontmatter (`id, doc, ts, kind, label, words, model?, instruction?`) under `.palimpsest/snapshots/` next to the workspace root (git-committable); file names sort chronologically. Pruning moves retired auto/system snapshots to `.palimpsest/archive/` (never destroys text by default). SQLite/FTS5 in `.palimpsest/index.db` is a **derived, rebuildable index**: `reindex()` rebuilds it from snapshot files; deleting `index.db` loses nothing.

**Snapshot state machine (§8.3):** IDLE → TRACKING → CAPTURED. Auto captures fire on idle ≥ 25 s AND churn ≥ 120 chars. Unconditional captures: file-open (system), before-restore (system, forced), after accepted AI edit (ai), named milestone (user/agent), session end.

## Stack (from spec §3)

Tauri 2 (Rust) + React 18 strict + TypeScript strict + Vite + Tailwind; CodeMirror 6 editor; Zustand UI state; v1.x: Vercel AI SDK (BYOK provider registry); MCP SDK for server + client; Vitest + Playwright + cargo test; pnpm workspaces. SQLite via `tauri-plugin-sql` (FTS5); durability test uses `node:sqlite` in core tests. Reference implementation: `reference/v0-single-file-prototype.html`. Deviations from spec need a PR in `docs/adr/`.

## Milestones & acceptance

### M0 — Project skeleton ✅ (done)

Repo, workspace, Tauri boot, CI, gates. Commits: scaffold, prototype relocation, CI fixes.

- [x] pnpm workspaces: `apps/desktop`, `packages/{core,ai,mcp}`
- [x] Tauri 2 app boots (`pnpm tauri dev`), icon set, sqlite plugin
- [x] CI: lint → typecheck → unit tests → MCP conformance → Playwright e2e → build
- [x] GitHub repo (private), issue/PR templates, AGENTS.md, CHANGELOG, README
- Acceptance: CI green incl. `cargo clippy -D warnings`; `pnpm tauri dev` shows hello-world window; core has zero DOM imports | **Lint gate currently red on main — fixed locally, riding along with M1' PR**

### M1' — Editor core (file-first memory) (in progress)

- [~] Markdown engine: renderer + AST, GFM tables/lists/task lists, callouts, footnotes, wikilinks, math, sanitized links — 28 fixture tests, 93.3 % cov ✅
- [~] Diff engine: hierarchical word-level, typed ops, progress, 50 k-word cap — 12 golden tests ✅
- [ ] **History store (file-backed rewrite)**: snapshot files + frontmatter, atomic writes, chronological names; `index.db` derived index; `reindex()`; archive-prune (keep ≥ 300 newest auto/system per doc, all ai/milestone); state machine policy (idle 25 s / churn 120); non-destructive restore (system before + milestone after)
- [ ] **Recall substrate**: `recall(query, budget)` ranked, budget-bounded bundle (spec Appendix D), deleted/modified/current status; `search(fts, include_deleted=true)`
- [ ] Editor (CodeMirror): split view (source ↔ rendered), diff highlight mode on current snapshot
- [x] Durability story: snapshots readable as plain `.md` with no app
- Acceptance: unit tests incl. **durability test** (write snapshots → delete index.db → reindex → history intact); snapshot files human-readable; restore yields exact prior text; deleted text retrievable via `recall`

### M2 — History UI + trust layer

- [ ] Time-scrubber (history drawer): scrub across snapshots → live word-diff of current text vs scrubbed snapshot
- [ ] Milestones: name/rename/filter; gone-text status ("deleted since") in history view
- [ ] Network transparency: persistent indicator lighting on any outbound request (destination shown); hard **Local-only toggle** blocking all outbound traffic; no request logging, ever
- [ ] Editor parity: callouts/wikilinks/footnotes/tables editing; keyboard shortcuts for diff accept/reject etc.
- Acceptance: scrubber shows exact word diff at any point in time; Local-only mode provably blocks network (manual + Playwright); offline edits fully functional

### M3 — AI (BYOK, offline-first)

- [ ] Provider registry (Vercel AI SDK) + OS keychain store; polaris studio / Ollama / LM Studio + OpenAI-compatible; no network required
- [ ] Inline edit → preview as word diff (core diff engine) → accept/reject; accept = ai milestone (model + instruction recorded)
- [ ] Chat panel with document context; cost metering
- [ ] `apply_edit` dry-run → diff-only writes; no silent AI writes
- Acceptance: full AI loop working with local model and zero network calls; keys live only in keychain; every AI mutation lands as a reviewable diff

### M4 — MCP spine (agents reach every core action)

- [x] MCP server (stdio + HTTP): `recall` (headline, budget-bounded), `get_outline`, `apply_edit` (+ dry_run), `create_milestone`, `restore_version` (+ dry_run), `export` (+ dry_run), `get_stats`, `get_document`; **every response includes `tokens_used`**; every mutating tool supports `dry_run`
- [x] MCP client (allowlists, audit log) for app-side assistant
- [ ] Conformance suite (replaces CI placeholder): include deleted-text recall + tokens_used assertions
- Acceptance: agent can do everything a human can (parity); conformance suite green; recall with `token_budget` never exceeds it and marks `truncated`

### M5 — Polish, durable memory, release

- [ ] README per spec §10 messaging hierarchy: headline → deleted-draft demo → durability → mechanism → trust layer → interface; roadmap lists §13 non-goals verbatim
- [ ] First-run welcome doc; onboarding microcopy; packaging (Linux deb/AppImage; mac/windows via CI)
- [ ] CHANGELOG v0.1.0; ADRs for any deviation
- Acceptance: §12 acceptance script passes on a clean machine (incl. deleted-draft recovery, time-scrub, recall via SDK, durability, offline AI, Local-only, `tokens_used`); v0.1.0 installers build in CI
