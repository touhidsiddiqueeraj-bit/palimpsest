# Palimpsest — Master Prompt (spec v2)

> **"The Markdown editor that remembers — so your AI can too."**
> Word-level time travel: automatic snapshots, named milestones, prose-aware diffs. AI edits arrive as reviewable word diffs, never silent rewrites.

This is the canonical product spec. The build plan is `PLAN.md`; build milestones in order (M0 → M5). Changes to this spec are PRs with ADRs.

## Laws (non-negotiable)

1. **File-first.** Source of truth is always plain `.md` files on disk. History is plain `.md` snapshot files. No proprietary vault, no database-as-truth.
2. **Local & private by default.** Text, history, API keys never leave the device except via an explicit, visible user action (save, export, or an AI request the user triggered). Keys live in the OS keychain only.
3. **The diff is the primitive.** Every revision feature — human or AI — flows through one word-level diff engine (`packages/core/src/diff/`).
4. **AI proposes, the diff decides.** AI edits are always previewed as a word diff and require explicit accept/reject before anything is written. Accepting creates an auto-milestone recording model + instruction.
5. **Human/AI parity.** Every AI capability is reachable by a human via UI/shortcut; every core human action is reachable by an AI via the MCP server.
6. **Model-agnostic, BYOK.** No first-party AI accounts, no proxying through our servers. All AI features must work with local models (Ollama / LM Studio / polaris studio) and zero network calls.
7. **No telemetry, no analytics, no dark patterns. Ever.**
8. **Every token counts.** Agent-side retrieval is context-budget-aware; every MCP response reports `tokens_used`.

## Product

- **The markdown editor that remembers.** Automatic, silent, durable word-level snapshots; your text, your history, your rules. Named milestones for human meaning-making. A time-scrubber that reanimates any past version as a readable word diff.
- **Memory for AI agents.** MCP server exposes every human capability. Headline tool: `palimpsest.recall` — agents ask "what did we decide about X?" and get a ranked, context-budget-sized memory bundle, including text deleted or rewritten since. Recall is temporal by default: most-relevant-recent-first; a snapshot is a point in time, an event, not a snapshot of a table.
- **Trust layer.** Network transparency: a persistent indicator lights on any outbound request (showing destination), plus a hard Local-only toggle that blocks all outbound traffic. No request logging, ever.
- **OS-native, privacy-grade.** Keychain-stored API keys, local-first file storage, app-free history files.

## Stack

Tauri 2 (Rust) + React 18 (strict) + TypeScript (strict) + Vite + Tailwind; CodeMirror 6 editor; Zustand for UI state. Vercel AI SDK for provider registry (BYOK). MCP SDK (server + client). Vitest, Playwright, cargo test. pnpm workspaces: `apps/desktop` (Tauri 2 app: React 18 + TS strict + Vite + Tailwind, CodeMirror 6), `packages/core` (pure TS engine: markdown renderer, diff engine, history, workspace; zero DOM imports), `packages/ai` (BYOK provider registry, task routing, inline edit, chat, cost metering), `packages/mcp` (MCP server stdio + HTTP; MCP client allowlists, audit log).

`reference/v0-single-file-prototype.html` is the source of truth for UX touches and the diff algorithm.

## History (v2 — file-based, app-independent)

- **Snapshots are full immutable Markdown files** with YAML frontmatter, stored under a `.palimpsest/` sidecar directory at the workspace root (git-committable, app-independent, readable as plain Markdown with any tool).
  - `id`, `doc`, `ts`, `kind` (`auto|system|ai|milestone`), `label`, `words`, `model?`, `instruction?`
  - File names sort chronologically.
- **SQLite/FTS5 in `.palimpsest/index.db` is a derived, rebuildable index** (documents, snapshots, FTS). `reindex()` rebuilds it from snapshot files; deleting `index.db` loses nothing.
- **Pruning:** keep all milestones and AI/agent snapshots forever; keep the newest 300 auto/system per document, then _move_ the rest to `.palimpsest/archive/` (never destroy text by default).
- **Snapshot state machine (IDLE → TRACKING → CAPTURED):** auto captures fire after idle ≥ 25 s and churn ≥ 120 chars. Unconditional captures: file-open (system), before-restore (system, forced), after accepted AI edit (ai), named milestone (user/agent), session end.
- **API (`packages/core/src/history/`)**: `capture`, `list`, `get`, `diff`, `restore` (non-destructive), `search(fts, include_deleted=true)`, `recall(query, budget)`, `prune`, `stats`, `reindex`.
- v1.5 note: plan sqlite-vec embeddings for semantic recall; keep `index.db` schema extensible, do not build now.

## Recall (Appendix D)

`recall(query, token_budget, scope?, document?, include?)` → ranked memory bundle:

```ts
{
  results: [{ kind, docId, docName, text, snippet, status, snapshotId?, ts? }],  // status: current | deleted | modified
  tokens_used: number,
  truncated: boolean
}
```

- Relevance-ranked; never exceed `token_budget`; `truncated` when cut.
- History snippets carry `status` so the agent knows the text is deleted or modified in the current document.
- Deleted text is always retrievable (snapshots are immutable).

## MCP tools

| Tool               | Read | Write | Notes                                                                                                                                        |
| ------------------ | ---- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall`           | ✓    |       | headline; budget-aware; D-shaped bundle                                                                                                      |
| `get_outline`      | ✓    |       | heading tree, list counts, links, words/section                                                                                              |
| `apply_edit`       |      | ✓     | diff-only; before-snapshot + milestone; needs local provider (local-only on) — with local-only off: any provider or agent-supplied `content` |
| `create_doc`       |      | ✓     | create .md + register; idempotent; `overwrite:true` replaces (snapshot-first); no AI needed                                                  |
| `create_milestone` |      | ✓     | label + optional note                                                                                                                        |
| `restore_version`  |      | ✓     | preview diff; confirm; system-before + milestone-after                                                                                       |
| `export`           |      | ✓     | to disk, dry-run for preview                                                                                                                 |
| `get_stats`        |      |       | snapshot counts, words, docs, storage; explicit missing doc errors (no fallback); no doc arg -> notes.md or first .md, named in response     |
| `get_document`     |      |       | read current doc or snapshot                                                                                                                 |

All tools accept document names with or without the `.md` suffix.

Every response includes `tokens_used`; every mutating tool supports `dry_run`. Design rules: context-budget-aware retrieval; temporal by default; projection-only structure (agents write only via patches on raw Markdown — no intermediate editable agent format, never human↔agent auto-conversion).

## UX essentials

- Split view: source (CM6) ↔ rendered; diff highlight mode; time-scrubber in history drawer; per-document history; milestones and auto snapshots; gone-text status (deleted since); keyboard shortcuts; offline-first; welcome doc with links on first run.
- First-run: wizard to pick workspace folder. Status bar: connection destination indicator, Local-only toggle, storage location.

## Non-goals (v1)

CRDT/collaboration, mobile apps, sync/cloud services, accounts/billing, WYSIWYG that hides source, plugin runtime, web publishing, hosted memory/vector DB, intermediate agent format, heavy AI-provenance tracking, "welcome back" briefings.

## Definition of done (v0.1.0)

1. Clean-machine install works
2. Edit → auto-snapshot → scrub → restore loop flawless
3. Deleted-draft demo works from a fresh clone of `.md` + `.palimpsest`
4. World-readable history files; durability: delete `index.db` → reindex → all history restored
5. AI loop (local model, zero network): propose → diff preview → accept → milestone
6. Local-only toggle blocks all outbound; indicator honest
7. MCP conformant: parity, recall, tokens_used, dry_run, deleted-text recall
8. README messaging hierarchy + documented non-goals roadmap
9. Retained milestone markers across reindex
10. v0.1.0 installers (deb/AppImage/mac/win) build in CI
