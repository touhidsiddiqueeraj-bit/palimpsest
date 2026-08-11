# Contributing to Palimpsest

Thanks for helping build the Markdown editor with a memory. Before you start,
read the product laws in `AGENTS.md` — they are non-negotiable, and any change
that violates them will be rejected.

## Dev setup

Prerequisites: Node ≥ 20, pnpm ≥ 10, Rust stable (1.7x+).

```bash
pnpm install                      # install everything (pnpm workspaces)
pnpm tauri dev                    # run the desktop app
pnpm test                         # unit tests (Vitest) — cargo test in src-tauri
pnpm typecheck && pnpm lint       # static checks
```

Linux system deps for Tauri: `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev
javascriptcoregtk-4.1-dev librsvg2-dev patchelf` (Arch: `webkitgtk-6.1 gtk3
libsoup3` equivalents under `webkit2gtk-4.1` names where applicable).

## Milestone map

| Milestone | Scope                                                                      |
| --------- | -------------------------------------------------------------------------- |
| M0        | Scaffold, CI, repo docs                                                    |
| M1        | `packages/core`: diff engine, markdown engine, history (SQLite), workspace |
| M2        | Editor parity with v0 prototype on CodeMirror 6 + SQLite                   |
| M3        | `packages/ai`: BYOK registry, task routing, inline edit, chat              |
| M4        | `packages/mcp`: server, client, conformance suite                          |
| M5        | Modes, export, docs, release automation                                    |

## Making a change

1. Find or open an issue; one logical change per PR.
2. Run the full local gate before pushing:
   ```bash
   pnpm lint && pnpm typecheck && pnpm test
   pnpm exec prettier --check .
   cd apps/desktop/src-tauri && cargo clippy -- -D warnings && cargo test && cargo fmt --check
   ```
3. Add or update tests. `packages/core` must stay ≥ 90% line coverage; the
   diff golden suite and renderer fixtures are the release gate.
4. Update `CHANGELOG.md` under `[Unreleased]` (keep-a-changelog format).
5. Open a PR against `main` using the template.

## Release process

Releases use Conventional Commits. To cut a release:

1. Merge PRs to `main` (CI must be green).
2. Update the `CHANGELOG.md` `[Unreleased]` section into a dated release
   heading, and bump `version` in: `package.json`, `apps/desktop/package.json`,
   `apps/desktop/src-tauri/Cargo.toml`, `apps/desktop/src-tauri/tauri.conf.json`.
   (Or run `pnpm changeset`-style tooling once introduced.)
3. Tag and push: `git tag v0.x.y && git push origin v0.x.y`
4. `release.yml` builds installers for Linux/macOS/Windows, drafts a GitHub
   Release with CHANGELOG notes and updater artifacts.

## Architecture rules

- **Capability layer:** document/history operations are implemented once in
  `packages/core` and consumed by the UI, chat tools, and the MCP server.
  Never duplicate logic.
- **Zero DOM imports** in `packages/core`.
- Any deviation from the spec (`docs/`) requires a short ADR in `docs/adr/`.

## Hard prohibitions

No telemetry, no analytics, no autoupdate-check-by-default, no accounts or
licensing, no server-side AI proxy, no silent AI writes, no keys outside the
OS keychain.
