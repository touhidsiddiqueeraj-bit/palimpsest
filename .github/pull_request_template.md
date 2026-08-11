## What does this PR do?

<!-- One paragraph. Link the issue if one exists. -->

## Verification

- [ ] `pnpm lint` green
- [ ] `pnpm typecheck` green
- [ ] `pnpm test` green (unit + MCP conformance)
- [ ] Playwright e2e green (if UI changed)
- [ ] `cargo clippy -- -D warnings` + `cargo test` green (if Rust changed)

## Product laws check

- [ ] No telemetry, analytics, or dark patterns introduced
- [ ] No data leaves the device beyond explicit user-triggered actions
- [ ] No new dependencies violate BYOK / local-first

## Changelog

- [ ] `CHANGELOG.md` updated under `[Unreleased]`
