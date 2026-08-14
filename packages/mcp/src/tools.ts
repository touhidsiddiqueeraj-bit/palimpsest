import { diffProse, renderMarkdown, type HistoryStore } from '@palimpsest/core';
import { inlineEdit, type AiClient } from '@palimpsest/ai';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * MCP tool layer (capability-layer pattern): every tool maps 1:1 onto
 * packages/core capabilities. Every response carries tokens_used; mutating
 * tools support dry_run (diff-only, never writes).
 */

export interface McpContext {
  store: HistoryStore;
  workspace: string;
  ai?: AiClient;
  localOnly: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: McpContext): Promise<unknown>;
}

const tokens = (s: string) => Math.ceil(s.length / 4);

/** Resolve a doc by its registered name; tolerate a missing `.md` suffix (create_doc registers `name.md`). */
async function resolveDocName(ctx: McpContext, docName: string) {
  try {
    return await ctx.store.resolveDoc(docName);
  } catch {
    if (!docName.endsWith('.md')) {
      try {
        return await ctx.store.resolveDoc(`${docName}.md`);
      } catch {
        /* fall through to the friendly error */
      }
    }
    throw new Error(`document not found: ${docName} (create it with create_doc)`);
  }
}

async function currentText(
  ctx: McpContext,
  docName: string,
): Promise<{ text: string; path: string }> {
  const doc = await resolveDocName(ctx, docName);
  const path = join(ctx.workspace, doc.path ?? `${doc.name}`);
  try {
    return { text: await readFile(path, 'utf8'), path };
  } catch {
    throw new Error(`document not found: ${docName} (create it with create_doc)`);
  }
}

async function writeCurrent(ctx: McpContext, docName: string, text: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  const { path } = await currentText(ctx, docName);
  await writeFile(path, text);
}

export const TOOLS: ToolDef[] = [
  {
    name: 'recall',
    description:
      'Recall memory snippets from document history, budget-bounded. Deleted text is included (marked status=deleted).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language memory query' },
        token_budget: { type: 'number', description: 'Max tokens for the bundle (default 4096)' },
        scope: {
          type: 'array',
          items: { type: 'string' },
          description: 'Doc ids or names to restrict to',
        },
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const bundle = await ctx.store.recall(String(args.query), Number(args.token_budget ?? 4096), {
        scope: (args.scope as string[] | undefined) ?? null,
      });
      const out = bundle.results.map((h) => ({
        status: h.status,
        kind: h.kind,
        doc: h.docName,
        text: h.text,
        snippet: h.snippet,
      }));
      return { results: out, truncated: bundle.truncated, tokens_used: bundle.tokensUsed };
    },
  },
  {
    name: 'get_outline',
    description: 'Heading outline of a document (from the markdown AST).',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'string', description: 'Document name or id' } },
      required: ['doc'],
    },
    async run(args, ctx) {
      const { text } = await currentText(ctx, String(args.doc));
      const { ast } = renderMarkdown(text);
      const outline = ast
        .filter((b): b is { type: 'heading'; level: number; text: string } => b.type === 'heading')
        .map((b) => ({ level: b.level, text: b.text }));
      return { doc: String(args.doc), outline, tokens_used: tokens(text) };
    },
  },
  {
    name: 'get_document',
    description: 'Full current text of a document (source of truth: the .md file).',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'string' } },
      required: ['doc'],
    },
    async run(args, ctx) {
      const { text } = await currentText(ctx, String(args.doc));
      return { text, tokens_used: tokens(text) };
    },
  },
  {
    name: 'get_stats',
    description:
      'Statistics for a document. Without doc: defaults to notes.md when present, else the first .md in the workspace root (the response names the document measured). An explicit doc that does not exist errors — no silent fallback.',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'string', description: 'Document name (with or without .md)' } },
    },
    async run(args, ctx) {
      const requested = String(args.doc ?? '').trim();
      let name = requested;
      if (!name) {
        const { readdir } = await import('node:fs/promises');
        const md = (await readdir(ctx.workspace).catch(() => [] as string[])).filter((f) =>
          f.endsWith('.md'),
        );
        name = md.includes('notes.md') ? 'notes.md' : (md[0] ?? 'notes.md');
      }
      const { text } = await currentText(ctx, name);
      const doc = await resolveDocName(ctx, name);
      const s = await ctx.store.stats(doc.id, text);
      return {
        document: doc.name,
        words: s.words,
        chars: s.chars,
        snapshots: s.snapshotCount,
        tokens_used: tokens(text),
      };
    },
  },
  {
    name: 'create_doc',
    description:
      'Create a new document (.md file in the workspace) and register it with history. Without content: idempotent — returns the existing document if the name is taken. With content on an existing document: requires overwrite:true, which snapshots the current state first, then writes the new content.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: 'Document name, e.g. "notes.md"' },
        content: {
          type: 'string',
          description: 'Optional initial text (default: a title heading)',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace an existing document (current state is snapshotted first)',
        },
      },
      required: ['doc'],
    },
    async run(args, ctx) {
      const name = String(args.doc);
      if (!name || name.includes('..') || name.startsWith('/') || name.includes('\\')) {
        throw new Error(`invalid document name: ${name}`);
      }
      const fileName = name.endsWith('.md') ? name : `${name}.md`;
      const path = join(ctx.workspace, fileName);
      const { writeFile } = await import('node:fs/promises');
      const raw = String(args.content ?? '');
      const text = raw.trim() ? raw : `# ${fileName.replace(/\.md$/, '')}\n\nStart writing.\n`;
      try {
        const current = await readFile(path, 'utf8');
        const doc = await ctx.store.getOrCreateDoc(fileName, fileName);
        if (!raw.trim()) return { created: false, doc_id: doc.id, document: doc.name };
        if (!args.overwrite) {
          throw new Error(
            `document already exists: ${fileName} — pass overwrite:true to replace it (the current state is snapshotted first), or use apply_edit for a word diff`,
          );
        }
        const before = await ctx.store.capture(doc.id, current, 'auto', 'create_doc overwrite');
        await writeFile(path, text);
        return {
          created: true,
          overwritten: true,
          doc_id: doc.id,
          document: doc.name,
          pre_edit_snapshot_id: before.id,
        };
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('document already exists')) throw err;
        // file does not exist yet — fall through and create it
      }
      await writeFile(path, text);
      const doc = await ctx.store.getOrCreateDoc(fileName, fileName);
      await ctx.store.capture(doc.id, text, 'auto', 'seed');
      return { created: true, doc_id: doc.id, document: doc.name };
    },
  },
  {
    name: 'create_milestone',
    description: 'Capture the current .md file as a named milestone.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string' },
        label: { type: 'string', description: 'Milestone label' },
        dry_run: { type: 'boolean', description: 'Return the snapshot text without writing' },
      },
      required: ['doc', 'label'],
    },
    async run(args, ctx) {
      const { text } = await currentText(ctx, String(args.doc));
      const doc = await resolveDocName(ctx, String(args.doc));
      if (args.dry_run) {
        return { dry_run: true, snapshot: text, tokens_used: tokens(text) };
      }
      const snap = await ctx.store.capture(doc.id, text, 'milestone', String(args.label));
      return { snapshot_id: snap.id, tokens_used: tokens(text) };
    },
  },
  {
    name: 'restore_version',
    description:
      'Restore a snapshot to the .md file. Non-destructive: the current state is captured first.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string' },
        snapshot_id: { type: 'number' },
        dry_run: { type: 'boolean' },
      },
      required: ['doc', 'snapshot_id'],
    },
    async run(args, ctx) {
      const { text } = await currentText(ctx, String(args.doc));
      const doc = await resolveDocName(ctx, String(args.doc));
      const target = await ctx.store.get(doc.id, Number(args.snapshot_id));
      if (args.dry_run) {
        return {
          dry_run: true,
          diff: {
            added: diffProse(text, target.text).added,
            removed: diffProse(text, target.text).removed,
          },
          tokens_used: tokens(text) + tokens(target.text),
        };
      }
      const r = await ctx.store.restore(doc.id, Number(args.snapshot_id), text, 'MCP restore');
      await writeCurrent(ctx, String(args.doc), r.text);
      return {
        restored_to: r.afterId,
        diff: { added: diffProse(text, r.text).added, removed: diffProse(text, r.text).removed },
        tokens_used: tokens(text) + tokens(r.text),
      };
    },
  },
  {
    name: 'apply_edit',
    description:
      'Apply an edit. With a configured AI provider: ask it to apply an instruction (diff-only when dry_run). Without a provider, local-only mode refuses; with local-only off, pass content (the agent is the editor) — the word diff, a before-snapshot, and a milestone are always recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string' },
        instruction: { type: 'string' },
        content: {
          type: 'string',
          description:
            'Agent-supplied full replacement text (used when no AI provider is configured and local-only is off)',
        },
        dry_run: { type: 'boolean' },
      },
      required: ['doc', 'instruction'],
    },
    async run(args, ctx) {
      const { text } = await currentText(ctx, String(args.doc));
      const instruction = String(args.instruction);
      let proposed: string;
      let diff: { added: number; removed: number };
      if (ctx.ai) {
        const edit = await inlineEdit({ client: ctx.ai, instruction, document: text });
        proposed = edit.proposed;
        diff = edit.diff;
      } else {
        const agentContent = String(args.content ?? '');
        if (ctx.localOnly) {
          throw new Error(
            'apply_edit: no local AI provider configured (local-only is on). Set PALIMPSEST_PROVIDER_URL to a local model, or turn local-only off and pass content.',
          );
        }
        if (!agentContent.trim()) {
          throw new Error(
            'apply_edit: no AI provider configured and no agent-supplied content. Set PALIMPSEST_PROVIDER_URL, or pass content (local-only is off).',
          );
        }
        proposed = agentContent;
        diff = diffProse(text, proposed);
      }
      if (args.dry_run) {
        return {
          dry_run: true,
          added: diff.added,
          removed: diff.removed,
          tokens_used: tokens(text) + tokens(proposed),
        };
      }
      const doc = await resolveDocName(ctx, String(args.doc));
      const before = await ctx.store.capture(doc.id, text, 'auto', 'pre-edit');
      await writeCurrent(ctx, String(args.doc), proposed);
      const snap = await ctx.store.capture(doc.id, proposed, 'ai', instruction, {
        model: ctx.ai?.provider.model ?? 'agent',
        instruction,
      });
      return {
        applied: `snapshot #${snap.id}`,
        added: diff.added,
        removed: diff.removed,
        pre_edit_snapshot_id: before.id,
        milestone_id: snap.id,
        tokens_used: tokens(text) + tokens(proposed),
      };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
