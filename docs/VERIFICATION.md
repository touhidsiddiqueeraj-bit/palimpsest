# Verification

Proof, not promises. Every claim below was reproduced on
2026-08-15 against this repository's own files (no fixtures): `PLAN.md`,
`CHANGELOG.md`, the smoke workspace `/tmp/opencode/md-ws`, and the desktop
app's own installed artifacts (deb contents, `~/.config`, `~/.local/share`).

## Summary

| Gate                          | Result                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| Unit tests                    | core **45/45** · ai **9/9** · mcp **18/18**                            |
| Typecheck                     | 0 errors (strict TS across packages)                                   |
| Lint + Prettier               | 0 errors / clean                                                       |
| MCP conformance suite         | green (vitest, included in `pnpm test`)                                |
| Live stdio server             | 13/13 smoke checks PASS (incl. milestone no-op contract)               |
| Live Streamable HTTP          | get_stats / recall / get_outline over raw `fetch()`                    |
| Registered as an opencode MCP | tools called in a running opencode session                             |
| Desktop: file-manager open    | `xdg-open notes.md` → app boots, full history + reconcile snapshot     |
| Desktop: OS registration      | deb ships `palimpsest.desktop` (MIME `text/markdown`, `%F`); `gio mime` default set |
| CI (GitHub Actions)           | `test` job green at HEAD of this documentation                         |

## 1. Unit tests (local)

```
$ pnpm --filter core exec vitest run   → 45 passed
$ pnpm --filter ai exec vitest run     → 9 passed
$ pnpm --filter mcp exec vitest run    → 18 passed
$ pnpm typecheck && pnpm lint          → 0 errors
```

## 2. MCP server — live stdio session

`packages/mcp/smoke.mjs` spawns the bundled server
(`dist/cli.cjs`, built by `pnpm --filter @palimpsest/mcp build:cli`) over
stdio and exercises every tool, including the dry-run guard on mutators:

```
PASS get_stats             {"document":"notes.md","words":9,"chars":52,"snapshots":1,"tokens_used":13}
PASS get_document          {"text":"# Alpha\n\nFirst notes for the palimpsest round trip.\n","tokens_used":13}
PASS get_outline           {"doc":"docs/one.md","outline":[{"level":1,"text":"Beta"}],"tokens_used":2}
PASS recall                status "current" · snippet "…First notes for the [palimpsest] round trip…"
PASS milestone dry_run     {"dry_run":true,"snapshot":"# Alpha…","tokens_used":13}
PASS milestone no-op       {"noop":true,"message":"no changes since snapshot #…","captured_external_change":null}
PASS milestone real        {"snapshot_id":1786782702157,"tokens_used":22}   ← after an external file edit
PASS restore dry_run       {"dry_run":true,"diff":{"added":0,"removed":0},"tokens_used":44}
PASS create_doc            {"created":true,"doc_id":3,"document":"smoke-new.md"}
PASS create_doc idempotent {"created":false,"doc_id":3,"document":"smoke-new.md"}
PASS bare-name lookup      {"text":"# smoke-new…","tokens_used":7}
PASS get_stats strict      document not found: nonexistent_doc_test (create it with create_doc)
PASS apply_edit guards     apply_edit: no local AI provider configured (local-only is on). Set PALIMPSEST_P…   ← no silent AI writes, by design
SMOKE OK
```

The script itself seeds a clean workspace (`/tmp/opencode/md-ws/notes.md`,
`docs/one.md`) and mutates the doc on disk mid-run to prove the external-edit
→ snapshot path; `create_milestone` on an unchanged doc no-ops.

## 3. MCP server — live Streamable HTTP

Same server, raw `fetch()` requests, one session:

```
POST / {"id":100,"method":"tools/call","params":{"name":"get_stats","arguments":{"doc":"PLAN.md"}}}
200  data: {"result":{"content":[{"type":"text","text":"{\n  \"document\": \"PLAN.md\",\n  \"words\": 1067, …

POST / {"id":200,"method":"tools/call","params":{"name":"recall","arguments":{"query":"history drawer","token_budget":256}}}
200  recall hits: 1 | statuses: current (first hit: CHANGELOG.md, "[history]" snippet)

POST / {"id":300,"method":"tools/call","params":{"name":"get_outline","arguments":{"doc":"CHANGELOG.md"}}}
200  1:Changelog | 2:[Unreleased] | 3:Added
```

Notes: responses are SSE (`event: message` + `data: <json>`); requests must
send `accept: application/json, text/event-stream`. HTTP sessions are
stateless per request by design (see ARCHITECTURE.md).

## 4. Registered as an opencode MCP — called in-session

The server is registered in `~/.config/opencode/opencode.json`
(`command: ["node", "<repo>/packages/mcp/dist/cli.cjs"]`, stdio). After an
opencode restart the tools were called directly in a live session:

```
palimpsest_get_stats(doc: "PLAN.md")  → {"document":"PLAN.md","words":1067,"chars":7203,"snapshots":1,"tokens_used":1801}
palimpsest_get_outline(doc: "PLAN.md") → 13 headings incl. "M0 — Project skeleton ✅ (done)",
                                          "M1' — Editor core (in progress)", … "M5 — Polish, durable memory, release"
palimpsest_recall(query: "history drawer diff", token_budget: 200)
  → 1 result, status "current", doc CHANGELOG.md,
    snippet "…as the source of truth for the [diff] algorithm…"
```

The recall hits come from the server's own bootstrap: at startup it walks
the workspace `.md` files and seeds a first snapshot for each, so the
index is real repo history, not a demo corpus.

## 5. Desktop — open `.md` from the file manager

Reproduced against the installed binary (no debug code) on 2026-08-15:

```
$ gio mime text/markdown                      → default: palimpsest.desktop
$ xdg-open ~/Documents/open-test.md           → app boots with that doc open
$ sqlite3 ~/Documents/.palimpsest/index.db "select label, snapshot from snapshots"
  → auto | initial         (seeded when the file was first opened)
  → auto | external change (captured when the file changed outside the app)
$ cat ~/.config/dev.palimpsest.app/workspace.txt   → /home/touhid/Documents
```

The `.desktop` shipped inside the installers was verified by extracting the
deb: `usr/share/applications/palimpsest.desktop` carries
`MimeType=text/markdown;text/x-markdown;`, `Categories=Utility;TextEditor;`,
`Exec=palimpsest %F`. Launching with no arguments reopens the persisted
workspace (`workspace.txt`); the demo fallback only appears when no workspace
was ever chosen.

Notes: the `.palimpsest` history tree must be allow-listed explicitly in the
runtime fs scope — Tauri's recursive `dir/**` glob never matches
dot-directories, so before the fix a fresh machine failed with
"forbidden path" and boot silently degraded.

## 6. CI

`.github/workflows/ci.yml` runs `lint → typecheck → unit tests (core, ai,
mcp incl. conformance) → MCP conformance → Playwright e2e → build check`.
Status at the commit tagged by this documentation: **`test` green**;
`build` (Tauri packaging) green or in-progress on the release branch;
CodeQL reports "code scanning is not enabled for this repository" — a repo
setting, not a code issue.

## 7. Privacy-relevant proof

- Snapshot storage is file-first: `.palimpsest/` beside the documents; the
  docs remain plain `.md` readable by any tool.
- Keys never appear in logs or the audit file; audit lines record
  `{ts, source, tool, args, ok|denied}` only.
- With no BYOK provider configured and local-only on (default), `apply_edit` returns
  `apply_edit: no local AI provider configured (local-only is on). Set
PALIMPSEST_PROVIDER_URL to a local model, or turn local-only off and pass
content.` and writes nothing — verified in §2 (the "guards" test). With
  local-only off, `apply_edit` applies agent-supplied `content` and records a
  before-snapshot plus milestone (conformance suite).

## Reproduce

```bash
pnpm install
pnpm --filter @palimpsest/mcp build:cli        # bundles dist/cli.cjs
pnpm test                                      # unit + conformance gates
pnpm exec prettier -c . && pnpm lint && pnpm typecheck
node --experimental-transform-types packages/mcp/smoke.mjs  # needs dist/cli.cjs on disk (bundles first)
# HTTP: node packages/mcp/dist/cli.cjs --workspace <dir> --port 3000
```
