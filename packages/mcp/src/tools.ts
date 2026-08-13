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

async function currentText(
  ctx: McpContext,
  docName: string,
): Promise<{ text: string; path: string }> {
  const doc = await ctx.store.resolveDoc(docName);
  const path = join(ctx.workspace, doc.path ?? `${doc.name}`);
  return { text: await readFile(path, 'utf8'), path };
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
      'Statistics for a document (default: notes.md, else the first registered document).',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'string', description: 'Document name' } },
    },
    async run(args, ctx) {
      const requested = String(args.doc ?? 'notes.md');
      const pick = async (name: string) => {
        const { text } = await currentText(ctx, name);
        const doc = await ctx.store.resolveDoc(name);
        const s = await ctx.store.stats(doc.id, text);
        return {
          document: name,
          words: s.words,
          chars: s.chars,
          snapshots: s.snapshotCount,
          tokens_used: tokens(text),
        };
      };
      try {
        return await pick(requested);
      } catch {
        // fall back to the first .md in the workspace root
        const { readdir } = await import('node:fs/promises');
        const first = (await readdir(ctx.workspace)).find((f) => f.endsWith('.md'));
        return pick(first ?? requested);
      }
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
      const doc = await ctx.store.resolveDoc(String(args.doc));
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
      const doc = await ctx.store.resolveDoc(String(args.doc));
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
      'Ask the configured AI to apply an instruction. dry_run returns only the word diff; without dry_run the edit is applied after review.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string' },
        instruction: { type: 'string' },
        dry_run: { type: 'boolean' },
      },
      required: ['doc', 'instruction'],
    },
    async run(args, ctx) {
      if (!ctx.ai) throw new Error('apply_edit: no AI provider configured');
      const { text } = await currentText(ctx, String(args.doc));
      const { proposed, diff } = await inlineEdit({
        client: ctx.ai,
        instruction: String(args.instruction),
        document: text,
      });
      if (args.dry_run) {
        return {
          dry_run: true,
          added: diff.added,
          removed: diff.removed,
          tokens_used: tokens(text) + tokens(proposed),
        };
      }
      const doc = await ctx.store.resolveDoc(String(args.doc));
      await writeCurrent(ctx, String(args.doc), proposed);
      const snap = await ctx.store.capture(doc.id, proposed, 'ai', String(args.instruction), {
        model: ctx.ai.provider.model,
        instruction: String(args.instruction),
      });
      return {
        applied: `snapshot #${snap.id}`,
        added: diff.added,
        removed: diff.removed,
        milestone_id: snap.id,
        tokens_used: tokens(text) + tokens(proposed),
      };
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
