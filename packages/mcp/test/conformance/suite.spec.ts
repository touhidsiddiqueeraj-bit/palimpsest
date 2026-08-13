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
let v1Id: number;
let store: HistoryStore;

const call = (name: string, args: Record<string, unknown> = {}) => {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool.run(args, ctx);
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
      'create_milestone',
      'restore_version',
      'apply_edit',
    ]);
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

  it('create_milestone captures the file content as a snapshot', async () => {
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
    const real = (await call('create_milestone', { doc: 'notes.md', label: 'probe' })) as {
      snapshot_id: number;
    };
    expect(real.snapshot_id).toBeGreaterThan(0);
    const snaps = await store.list((await store.resolveDoc('notes.md')).id);
    expect(snaps.some((s) => s.label === 'probe')).toBe(true);
  });

  it('get_outline derives headings from the markdown AST', async () => {
    const r = (await call('get_outline', { doc: 'notes.md' })) as {
      outline: Array<{ level: number; text: string }>;
    };
    expect(r.outline).toEqual([{ level: 1, text: 'Alpha' }]);
  });
});
