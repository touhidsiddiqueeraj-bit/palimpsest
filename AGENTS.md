# AGENTS.md — Palimpsest

Local-first, revision-aware Markdown editor for humans and AI agents. Word-level time travel: automatic snapshots, named milestones, prose-aware diffs. AI edits arrive as reviewable word diffs, never silent rewrites.

## Product Laws (non-negotiable)

1. **File-first.** Source of truth is always plain `.md` files on disk. No proprietary vault, no database-as-truth.
2. **Local & private by default.** Text, history, and API keys never leave the device except via an explicit, visible user action (save, export, or an AI request the user triggered).
3. **The diff is the primitive.** All revision features — human or AI — flow through one word-level diff engine (`packages/core/src/diff/`).
4. **AI proposes, the diff decides.** AI edits are always previewed as a word diff and require explicit accept/reject. Accepting creates an auto-milestone recording model + instruction.
5. **Human/AI parity.** Every AI capability is reachable by a human via UI/shortcut; every core human action is reachable by an AI via the MCP server.
6. **Model-agnostic, BYOK.** No first-party AI accounts, no proxying through our servers. Keys live in the OS keychain only. All AI features must work with a local model (Ollama / LM Studio / polaris studio) and zero network calls.
7. **No telemetry, no analytics, no dark patterns. Ever.**

## Repo map

| Path | Contents |
|------|----------|
| `apps/desktop/` | Tauri 2 desktop app: React 18 + TypeScript strict + Vite + Tailwind, CodeMirror 6 editor |
| `packages/core/` | Pure TS engine: markdown renderer, diff engine, history (SQLite), workspace. **Zero DOM imports.** |
| `packages/ai/` | BYOK provider registry (Vercel AI SDK), task routing, inline edit, chat, cost metering |
| `packages/mcp/` | MCP server (stdio + HTTP) and MCP client (allowlists, audit log) |
| `reference/v0-single-file-prototype.html` | The v0 prototype — source of truth for UX touches and the diff algorithm |
| `docs/adr/` | Architecture Decision Records |

## Capability layer pattern (architecture rule)

Document/history operations are implemented **once** in `packages/core` as a typed capability API. The app UI, the chat tool-caller, and the MCP server all consume that same API. **Never duplicate logic** in the UI, chat tools, or MCP tools.

## Commands

```bash
pnpm install          # install everything (pnpm workspaces)
pnpm test             # run all unit tests (Vitest: core/ai/mcp) — cargo test in src-tauri
pnpm typecheck        # tsc --noEmit across packages
pnpm lint             # eslint + prettier check
pnpm build            # build all packages
pnpm tauri dev        # run the desktop app
pnpm tauri build      # produce installers (Linux: deb/AppImage)
```

CI runs: lint → typecheck → unit tests → MCP conformance → Playwright e2e → build check.

## Quality gates

- `packages/core` line coverage ≥ 90%; diff golden suite and renderer fixtures are the release gate.
- MCP conformance suite (`packages/mcp`) must be green in CI.
- Rust: `cargo clippy -D warnings` + `cargo test`.
- Never push with failing tests. Conventional Commits; update `CHANGELOG.md` per PR.

## Hard prohibitions

Telemetry/analytics/autoupdate-check-by-default, accounts/licensing, any server-side AI proxy, silent AI writes, keys outside the OS keychain.
