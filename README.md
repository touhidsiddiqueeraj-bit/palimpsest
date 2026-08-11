# Palimpsest

> The Markdown editor with a memory.

[![CI](https://github.com/touhidsiddiqueeraj-bit/palimpsest/actions/workflows/ci.yml/badge.svg)](https://github.com/touhidsiddiqueeraj-bit/palimpsest/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/touhidsiddiqueeraj-bit/palimpsest)](https://github.com/touhidsiddiqueeraj-bit/palimpsest/releases)

Every serious creative tool treats history as a first-class citizen. Markdown
editors don't — line-based diffs (Git) are wrong for prose, because a
rewrapped paragraph reads as a total rewrite. Palimpsest fixes that with
**word-level time travel**: automatic snapshots, named milestones, and
prose-aware diffs. AI is woven into the same wedge: AI edits arrive as
reviewable word diffs, never silent rewrites.

**Nothing leaves your device.** Text, history, and API keys stay local —
keys live in your OS keychain, and AI features work with your own keys or a
local model (Ollama / LM Studio / polaris studio) with zero network calls.
No account. No telemetry. Ever.

## Features

- **Word-level time travel** — automatic snapshots when you pause, named
  milestones, prose-aware diffs (rewrapping a paragraph changes zero words).
- **History drawer** — timeline, per-snapshot "View changes", restore
  anything fearlessly (restores are themselves snapshotted).
- **AI proposes, the diff decides** — inline edits, autocomplete, critique
  and chat; every AI edit is previewed as a word diff with explicit
  accept/reject, and accepting records the model + instruction.
- **BYOK provider registry** — OpenAI, Anthropic, Gemini, Mistral, Groq,
  xAI, OpenRouter, Azure, Ollama, any OpenAI-compatible endpoint.
- **MCP server & client** — Claude Desktop / Claude Code / Cursor can read
  and edit your documents with the same confirmations a human gets; Palimpsest
  can also call external MCP tools behind per-tool allowlists and an audit log.
- **Modes** — fiction, technical docs, notes, blogging, journaling, academic:
  templates, snippets, AI prompts, lint hints, export defaults per context.
- **Export** — Markdown, standalone HTML, Print → PDF, multi-file compile.
- Editor with the touches that matter: Write/Split/Read, typewriter scroll,
  zen mode, focus mode, command palette, themes, welcome document.

## Quick start (developers)

```bash
pnpm install
pnpm tauri dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev setup, and
[AGENTS.md](AGENTS.md) for the product laws and repo map.

## Install

Download the installer for your platform from the
[latest release](https://github.com/touhidsiddiqueeraj-bit/palimpsest/releases).

## BYOK setup

1. Open **Settings → AI Providers**.
2. Add your provider and paste your API key — it goes straight into your OS
   keychain, never into a database or log file.
3. Prefer local? Point any OpenAI-compatible provider at your local endpoint
   (e.g. `http://localhost:11434/v1` for Ollama) and enable **Offline Mode**.

## MCP setup

Palimpsest ships an MCP server. Claude Desktop config snippet:

```json
{
  "mcpServers": {
    "palimpsest": {
      "command": "palimpsest-mcp",
      "args": ["--transport", "stdio"]
    }
  }
}
```

## Privacy statement

Palimpsest is local-first by default. Your text, your history, and your API
keys never leave your device except via an explicit, visible action you
trigger: saving, exporting, or an AI request. There is no telemetry, no
analytics, and no phone-home — by design and by code review gate.

## Roadmap

- **v0.1** — word-level history, milestones, prose-aware diffs, MCP server
- **v0.2** — AI layer: BYOK registry, inline edit, autocomplete, chat
- **v0.3** — Modes, multi-file compile export, MCP client
- Later — plugin JS runtime (architecture leaves room), academic export
  (Pandoc detection)

## License

MIT — see [LICENSE](LICENSE).
