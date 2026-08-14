# Verification

Proof, not promises. Every claim below was reproduced on
2026-08-13 against this repository's own files (no fixtures): `PLAN.md`,
`CHANGELOG.md`, and the smoke workspace `/tmp/opencode/md-ws`.

## Summary

| Gate                          | Result                                                                 |
| ----------------------------- | ---------------------------------------------------------------------- |
| Unit tests                    | core **43/43** · ai **9/9** · mcp **10/10** (8 conformance + 2 client) |
| Typecheck                     | 0 errors (strict TS across packages)                                   |
| Lint + Prettier               | 0 errors / clean                                                       |
| MCP conformance suite         | green (vitest, included in `pnpm test`)                                |
| Live stdio server             | 8/8 smoke checks PASS                                                  |
| Live Streamable HTTP          | get_stats / recall / get_outline over raw `fetch()`                    |
| Registered as an opencode MCP | tools called in a running opencode session                             |
| CI (GitHub Actions)           | `test` job green at HEAD of this documentation                         |

## 1. Unit tests (local)

```
$ pnpm --filter core exec vitest run   → 43 passed
$ pnpm --filter ai exec vitest run     → 9 passed
$ pnpm --filter mcp exec vitest run    → 10 passed
$ pnpm typecheck && pnpm lint          → 0 errors
```

## 2. MCP server — live stdio session

`packages/mcp/smoke.mjs` spawns the bundled server
(`dist/cli.cjs`, built by `pnpm --filter @palimpsest/mcp build:cli`) over
stdio and exercises every tool, including the dry-run guard on mutators:

```
PASS get_stats             {"document":"notes.md","words":9,"chars":52,"snapshots":3,"tokens_used":13}
PASS get_document          {"text":"# Alpha\n\nFirst notes for the palimpsest round trip.\n","tokens_used":13}
PASS get_outline           {"doc":"docs/one.md","outline":[{"level":1,"text":"Beta"}],"tokens_used":11}
PASS recall                status "current" · snippet "…First notes for the [palimpsest] round trip…"
PASS milestone dry_run     {"dry_run":true,"snapshot":"# Alpha…","tokens_used":13}
PASS milestone real        {"snapshot_id":1786619923052,"tokens_used":13}
PASS restore dry_run       {"dry_run":true,"diff":{"added":0,"removed":0},"tokens_used":26}
PASS apply_edit guards     apply_edit: no local AI provider configured (local-only is on). Set PALIMPSEST_P…   ← no silent AI writes, by design
SMOKE OK
```

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

## 5. CI

`.github/workflows/ci.yml` runs `lint → typecheck → unit tests (core, ai,
mcp incl. conformance) → MCP conformance → Playwright e2e → build check`.
Status at the commit tagged by this documentation: **`test` green**;
`build` (Tauri packaging) green or in-progress on the release branch;
CodeQL reports "code scanning is not enabled for this repository" — a repo
setting, not a code issue.

## 6. Privacy-relevant proof

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
