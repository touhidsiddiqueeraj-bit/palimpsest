import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
// relative import (matches core's own test pattern): package-name imports
// engage vite's dep optimizer, which chokes on node:sqlite (vite <6)
import {
  createHistoryStore,
  type HistoryStore,
  type SqliteDb,
  type SnapshotFs,
} from '../../../core/src/index.js';
import { TOOLS, type McpContext } from '../../src/index.js';

function memoryDb(): SqliteDb {
  const d = new DatabaseSync(':memory:');
  return {
    async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = d.prepare(sql);
      return (params.length ? stmt.all(...(params as never[])) : stmt.all()) as T[];
    },
    async execute(
      sql: string,
      params: unknown[] = [],
    ): Promise<{ lastInsertId: number; changes: number }> {
      const stmt = d.prepare(sql);
      const r = stmt.run(...(params as never[]));
      return { lastInsertId: Number(r.lastInsertRowid), changes: Number(r.changes ?? 1) };
    },
  };
}

function demoFs(root: string): SnapshotFs {
  const dir = (archived: boolean) => join(root, '.palimpsest', archived ? 'archive' : 'snapshots');
  return {
    async list() {
      const out: Array<{ name: string; archived: boolean }> = [];
      for (const archived of [false, true]) {
        try {
          for (const name of await readdir(dir(archived))) out.push({ name, archived });
        } catch {
          /* not created yet */
        }
      }
      return out;
    },
    async read(name, archived) {
      return readFile(join(dir(archived), name), 'utf8');
    },
    async write(name, text) {
      await mkdir(dir(false), { recursive: true });
      await writeFile(join(dir(false), name), text);
    },
    async moveToArchive(name) {
      await mkdir(dir(true), { recursive: true });
      await rename(join(dir(false), name), join(dir(true), name));
    },
  };
}

let ws: string;
let ctx: McpContext;
let openCtx: McpContext;
let v1Id: number;
let store: HistoryStore;

const call = (name: string, args: Record<string, unknown> = {}) => callWith(name, args, ctx);

const callWith = (name: string, args: Record<string, unknown> = {}, c: McpContext) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, c);
};

beforeAll(async () => {
  ws = await mkdtemp(join(tmpdir(), 'palimpsest-mcp-'));
  await mkdir(join(ws, '.palimpsest', 'snapshots'), { recursive: true });
  const db = memoryDb();
  const fs = demoFs(ws);
  store = createHistoryStore(db, fs);
  await store.init();
  const doc = await store.getOrCreateDoc('notes.md', 'notes.md');
  await writeFile(join(ws, 'notes.md'), '# Alpha\n\nThe quick brown fox jumps.\n');
  const v1 = await store.capture(
    doc.id,
    '# Alpha\n\nThe quick brown fox jumps.\n',
    'milestone',
    'v1',
  );
  await store.capture(doc.id, '# Alpha\n\nThe lazy dog sleeps.\n', 'milestone', 'v2');
  v1Id = v1.id;
  ctx = { store, workspace: ws, localOnly: true };
  openCtx = { store, workspace: ws, localOnly: false };
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe('conformance (MCP server tools)', () => {
  it('lists the full capability surface', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'recall',
      'get_outline',
      'get_document',
      'get_stats',
      'create_doc',
      'create_milestone',
      'restore_version',
      'apply_edit',
    ]);
  });

  it('create_doc writes the file, registers the doc, and is idempotent', async () => {
    const made = (await call('create_doc', { doc: 'fresh.md' })) as {
      created: boolean;
      doc_id: number;
    };
    expect(made.created).toBe(true);
    expect(made.doc_id).toBeGreaterThan(0);
    const text = await readFile(join(ws, 'fresh.md'), 'utf8');
    expect(text).toContain('# fresh');
    const again = (await call('create_doc', { doc: 'fresh.md' })) as {
      created: boolean;
      doc_id: number;
    };
    expect(again.created).toBe(false);
    expect(again.doc_id).toBe(made.doc_id);
    const seeded = await store.list(made.doc_id);
    expect(seeded.length).toBe(1);
    expect(seeded[0]!.kind).toBe('auto');

    const custom = (await call('create_doc', {
      doc: 'custom',
      content: '# Custom\n\nBody.\n',
    })) as {
      created: boolean;
    };
    expect(custom.created).toBe(true);
    expect(await readFile(join(ws, 'custom.md'), 'utf8')).toBe('# Custom\n\nBody.\n');
  });

  it('create_doc rejects unsafe names and missing docs hint at create_doc', async () => {
    await expect(call('create_doc', { doc: '../escape.md' })).rejects.toThrow(/invalid document/);
    await expect(call('create_doc', { doc: '/abs/olute.md' })).rejects.toThrow(/invalid document/);
    await expect(call('get_document', { doc: 'nope.md' })).rejects.toThrow(/create_doc/);
  });

  it('doc names accept with or without the .md suffix across all tools', async () => {
    await call('create_doc', { doc: 'bare' });
    const doc = (await call('get_document', { doc: 'bare' })) as { text: string };
    expect(doc.text).toContain('# bare');
    expect(((await call('get_document', { doc: 'bare.md' })) as { text: string }).text).toBe(
      doc.text,
    );
    expect(
      ((await call('get_outline', { doc: 'bare' })) as { outline: unknown[] }).outline,
    ).toHaveLength(1);
    const stats = (await call('get_stats', { doc: 'bare' })) as { document: string };
    expect(stats.document).toBe('bare.md');
    const dry = (await call('create_milestone', {
      doc: 'bare',
      label: 'naming',
      dry_run: true,
    })) as { dry_run: boolean };
    expect(dry.dry_run).toBe(true);
    // apply_edit resolves names too (guard fires only after resolution)
    await expect(
      call('apply_edit', { doc: 'bare', instruction: 'x', dry_run: true }),
    ).rejects.toThrow(/local AI provider configured/);
  });

  it('get_stats errors on an explicit missing doc, names the default doc otherwise', async () => {
    await expect(call('get_stats', { doc: 'nonexistent_doc_test' })).rejects.toThrow(/create_doc/);
    const picked = (await call('get_stats')) as { document: string; snapshots: number };
    expect(picked.document).toBe('notes.md');
    expect(picked.snapshots).toBeGreaterThan(0);
  });

  it('create_doc overwrites only with the flag, capture-first', async () => {
    await writeFile(join(ws, 'over.md'), '# Old\n');
    await expect(call('create_doc', { doc: 'over.md', content: '# New\n' })).rejects.toThrow(
      /overwrite:true/,
    );
    expect(await readFile(join(ws, 'over.md'), 'utf8')).toBe('# Old\n');
    const r = (await call('create_doc', {
      doc: 'over.md',
      content: '# New\n',
      overwrite: true,
    })) as { overwritten: boolean; pre_edit_snapshot_id: number };
    expect(r.overwritten).toBe(true);
    expect(r.pre_edit_snapshot_id).toBeGreaterThan(0);
    expect(await readFile(join(ws, 'over.md'), 'utf8')).toBe('# New\n');
    const doc = await store.getOrCreateDoc('over.md', 'over.md');
    const pre = await store.get(doc.id, r.pre_edit_snapshot_id);
    expect(pre.text).toBe('# Old\n');
  });

  it('apply_edit with local-only on and no provider refuses with a hint', async () => {
    await expect(
      call('apply_edit', { doc: 'notes.md', instruction: 'x', dry_run: true }),
    ).rejects.toThrow(/local AI provider configured/);
  });

  it('apply_edit agent-supplied content (local-only off): diff + pre-snapshot + milestone', async () => {
    const beforeText = await readFile(join(ws, 'notes.md'), 'utf8');
    const dry = (await callWith(
      'apply_edit',
      { doc: 'notes.md', instruction: 'rewrite', content: '# Agent\n\nNew body.\n', dry_run: true },
      openCtx,
    )) as { dry_run: boolean; added: number };
    expect(dry.dry_run).toBe(true);
    expect(dry.added).toBeGreaterThan(0);
    expect(await readFile(join(ws, 'notes.md'), 'utf8')).toBe(beforeText);
    const real = (await callWith(
      'apply_edit',
      { doc: 'notes.md', instruction: 'rewrite', content: '# Agent\n\nNew body.\n' },
      openCtx,
    )) as { pre_edit_snapshot_id: number; milestone_id: number; added: number };
    expect(real.pre_edit_snapshot_id).toBeGreaterThan(0);
    expect(real.milestone_id).toBeGreaterThan(0);
    expect(real.added).toBeGreaterThan(0);
    expect(await readFile(join(ws, 'notes.md'), 'utf8')).toContain('# Agent');
    const doc = await store.resolveDoc('notes.md');
    const pre = await store.get(doc.id, real.pre_edit_snapshot_id);
    expect(pre.text).toBe(beforeText);
    const milestone = await store.get(doc.id, real.milestone_id);
    expect(milestone.kind).toBe('ai');
  });

  it('apply_edit local-only off, no provider, no content: names both options', async () => {
    await expect(
      callWith('apply_edit', { doc: 'notes.md', instruction: 'x', dry_run: true }, openCtx),
    ).rejects.toThrow(/PALIMPSEST_PROVIDER_URL.*content|content.*PALIMPSEST_PROVIDER_URL/);
  });

  it('recall returns superseded text, annotated with its status', async () => {
    // supersede v1 with a feline edition, then restore v1 as current again,
    // so recall has a 'modified' row to surface
    const doc = await store.getOrCreateDoc('notes.md', 'notes.md');
    const feline = '# Chapter one\n\nThe quick brown feline jumps over the lazy dog.\n';
    await store.capture(doc.id, feline, 'auto', 'v2');
    expect(
      (
        (await call('restore_version', { doc: 'notes.md', snapshot_id: v1Id, dry_run: false })) as {
          restored_to: number;
        }
      ).restored_to,
    ).toBeTruthy();
    const r = (await call('recall', { query: 'brown', token_budget: 512 })) as {
      results: Array<{ status: string; text: string }>;
      tokens_used: number;
      truncated: boolean;
    };
    expect(r.truncated).toBe(false);
    expect(r.tokens_used).toBeGreaterThan(0);
    expect(r.results.some((h) => h.status === 'modified' && h.text.includes('feline'))).toBe(true);
    expect(r.results.some((h) => h.status === 'current' && h.text.includes('fox'))).toBe(true);
  });

  it('recall honors token_budget and marks truncation', async () => {
    for (let i = 0; i < 30; i++) {
      const doc = await store.getOrCreateDoc(`d${i}.md`, `d${i}.md`);
      await store.capture(doc.id, `Entry ${i}: the quick brown fox jumps again. `, 'auto', `x${i}`);
    }
    const r = (await call('recall', { query: 'fox', token_budget: 64 })) as {
      truncated: boolean;
      tokens_used: number;
    };
    expect(r.truncated).toBe(true);
    expect(r.tokens_used).toBeLessThanOrEqual(64 + 64);
  });

  it('every response carries tokens_used', async () => {
    const outline = (await call('get_outline', { doc: 'notes.md' })) as { tokens_used: number };
    expect(outline.tokens_used).toBeGreaterThan(0);
    expect(outline).toHaveProperty('outline');
    const doc = (await call('get_document', { doc: 'notes.md' })) as { tokens_used: number };
    expect(doc.tokens_used).toBeGreaterThan(0);
    const stats = (await call('get_stats')) as { tokens_used: number };
    expect(stats.tokens_used).toBeGreaterThan(0);
    const dry = (await call('create_milestone', {
      doc: 'notes.md',
      label: 'probe',
      dry_run: true,
    })) as {
      tokens_used: number;
    };
    expect(dry.tokens_used).toBeGreaterThan(0);
    const restore = (await call('restore_version', {
      doc: 'notes.md',
      snapshot_id: v1Id,
      dry_run: true,
    })) as {
      tokens_used: number;
    };
    expect(restore.tokens_used).toBeGreaterThan(0);
  });

  it('dry_run never writes, real calls do', async () => {
    const before = await readFile(join(ws, 'notes.md'), 'utf8');
    const dry = (await call('restore_version', {
      doc: 'notes.md',
      snapshot_id: v1Id,
      dry_run: true,
    })) as { dry_run: boolean };
    expect(dry.dry_run).toBe(true);
    expect(await readFile(join(ws, 'notes.md'), 'utf8')).toBe(before);
    await call('restore_version', { doc: 'notes.md', snapshot_id: v1Id });
    const after = await readFile(join(ws, 'notes.md'), 'utf8');
    expect(after).toContain('quick brown fox');
  });

  it('create_milestone captures changed file content; no-ops when unchanged', async () => {
    const before = await readFile(join(ws, 'notes.md'), 'utf8');
    const dry = (await call('create_milestone', {
      doc: 'notes.md',
      label: 'probe',
      dry_run: true,
    })) as {
      dry_run: boolean;
      snapshot: string;
    };
    expect(dry.dry_run).toBe(true);
    expect(dry.snapshot).toBe(before);
    const noop = (await call('create_milestone', { doc: 'notes.md', label: 'probe' })) as {
      noop: boolean;
      message: string;
    };
    expect(noop.noop).toBe(true);
    expect(noop.message).toContain('no changes since snapshot');
    await writeFile(join(ws, 'notes.md'), before + '\nNew milestone-worthy line.\n');
    const real = (await call('create_milestone', { doc: 'notes.md', label: 'probe' })) as {
      snapshot_id: number;
    };
    expect(real.snapshot_id).toBeGreaterThan(0);
    const snaps = await store.list((await store.resolveDoc('notes.md')).id);
    expect(snaps.some((s) => s.label === 'probe')).toBe(true);
  });

  it('http transport serves the same tool surface', async () => {
    const { runHttpServer } = await import('../../src/index.js');
    const server = await runHttpServer(ctx, 0);
    const res = await fetch('http://127.0.0.1:' + (server.address() as { port: number }).port, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const dataLine = raw
      .split('\n')
      .find((l) => l.startsWith('data: '))!
      .slice(6);
    const body = JSON.parse(dataLine) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    server.close();
  });

  it('get_outline derives headings from the markdown AST', async () => {
    const r = (await call('get_outline', { doc: 'notes.md' })) as {
      outline: Array<{ level: number; text: string }>;
    };
    expect(r.outline).toEqual([{ level: 1, text: 'Alpha' }]);
  });
});
