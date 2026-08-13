# Architecture

Palimpsest is a pnpm monorepo. This document describes the runtime
architecture at the level you need to extend it safely.

## The capability layer (one implementation, three consumers)

```
                ┌───────────────┐
                │  desktop app  │  React 18 + CodeMirror 6 (Tauri 2)
                └───────┬───────┘
                        │
   ┌────────────────────┼────────────────────┐
   │        packages/core  (capability API)  │
   │  diff engine · history store · recall   │
   │  markdown renderer (pure TS, zero DOM)  │
   └───────┬────────────────────┬────────────┘
           │                    │
   ┌───────┴───────┐    ┌───────┴──────────┐
   │ packages/mcp  │    │ packages/ai      │
   │ server+client │    │ BYOK, offline    │
   │ (stdio/HTTP)  │    │ propose→diff→ok  │
   └───────────────┘    └──────────────────┘
```

**Rule:** document/history operations are implemented _once_ in
`packages/core` as a typed capability API. The app UI, the chat
tool-caller, and the MCP server all consume that same API. Never duplicate
logic in the UI, chat tools, or MCP tools — an agent reaching through MCP
gets exactly the same behavior and guarantees as a human at the keyboard
(product law 5).

## The diff is the primitive

All revision features — human or AI — flow through one word-level diff
engine (`packages/core/src/diff/`). Prose-aware means a rewrapped paragraph
is not a total rewrite: added/removed words are counted, reordered words
are an insertion + deletion of the moved span, and the engine reports
progress for long documents. The v0 prototype
(`reference/v0-single-file-prototype.html`) remains the source of truth for
the diff algorithm and UX touches; the diff golden suite pins its behavior.

## File-first storage

- **Source of truth: plain `.md` files.** Documents live wherever you put
  them. Snapshots are immutable `.md` files with YAML frontmatter under
  `.palimpsest/snapshots/`; pruning moves retired system snapshots to
  `.palimpsest/archive/`.
- **Derived index: SQLite + FTS5** (`.palimpsest/index.db`). Words, diffs,
  milestone labels, FTS rows. It is rebuildable from the snapshot files via
  `reindex()` — losing the database costs nothing but time.
- `restore` writes the restored text and records the pre-restore state as a
  snapshot, so restores are themselves reversible.

## Recall: context-budget-aware memory

`store.recall(query, tokenBudget)` returns ranked memory bundles with a
per-snapshot status relative to the current text:

- `current` — the snapshot matches today's text
- `modified` — the document moved on; the snapshot shows an earlier state
- `deleted` — the document file no longer exists

Every bundle includes `tokens_used` so callers (humans or agents) can
budget context precisely.

## MCP spine (packages/mcp)

- **Server** — capability-layer tools over stdio (`runStdioServer`) or
  Streamable HTTP (`runHttpServer`). Tools: `recall`, `get_document`,
  `get_outline`, `get_stats`, `create_milestone`, `restore_version`,
  `apply_edit`. Every mutator accepts `dry_run`; every response carries
  `tokens_used`. Tool schemas are declared as JSON Schema and converted to
  Zod shapes with required/optional fidelity for the MCP SDK.
- **HTTP is stateless per request** — a fresh server + transport per
  request (SDK session state breaks when one transport handles more than
  one request); errors log server-side and return HTTP 500 rather than
  dying silently.
- **CLI** (`src/cli.ts`) — the runnable server: `node dist/cli.cjs
--workspace <dir> [--port <p>]`. Boots by indexing the workspace
  (first snapshot per `.md`), skips `.git/.palimpsest/node_modules/dist/…`,
  and wires a BYOK AI client from `PALIMPSEST_PROVIDER_URL` /
  `PALIMPSEST_MODEL` / `PALIMPSEST_LOCAL_ONLY` when present. The bundle is
  CJS by necessity: the MCP SDK's `cross-spawn` dynamic require breaks ESM
  bundles.
- **Client** — tool calls behind a per-tool allowlist; every call (granted
  or denied) is written to the audit log (`PALIMPSEST_AUDIT`), so an agent
  can't touch the filesystem outside your rules, and can't do so invisibly.

## AI: propose, never write

`packages/ai` is BYOK and offline-first — it must work with a local model
and zero network calls. Protocol adapters sit behind a provider registry
(Ollama / LM Studio / OpenAI-compatible). The trust model is
**AI proposes, the diff decides**: inline edits and chat proposals are
rendered as word diffs against the current document, require explicit
acceptance, and an accepted edit captures an auto-milestone recording the
model + instruction. There is no path that lets the model write silently.

## Network transparency

`apps/desktop/src/netguard.ts` wraps fetch/XHR/WebSocket: every outbound
request lights a status indicator with the destination host, and the hard
**Local-only** toggle blocks every non-localhost request at the wrapper.
Keys live in the OS keychain.

## Decision history

See [docs/adr/](docs/adr/) for Architecture Decision Records covering
snapshot format (file-first, spec v2), the capability layer, and other
branching decisions.
