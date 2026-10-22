import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeSnapshotFs } from '../helpers/node-fs-backend.js';
import { memoryDb } from '../helpers/memory-db.js';
import { createHistoryStore } from '../../src/history/store.js';
import type { SnapshotFs } from '../../src/history/types.js';

describe('file-backed history store', () => {
  let store: ReturnType<typeof createHistoryStore>;
  let fs: SnapshotFs;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'palimpsest-'));
    fs = nodeSnapshotFs(root);
    store = createHistoryStore(memoryDb(), fs);
    await store.init();
  });

  const setup = async () => {
    const doc = await store.getOrCreateDoc('notes.md');
    const v1 = await store.capture(doc.id, 'The quick brown fox jumps over the lazy dog.');
    const v2 = await store.capture(doc.id, 'The lazy dog sleeps all day.', 'auto');
    const v1t = (await store.get(doc.id, v1.id)).text;
    const v2t = (await store.get(doc.id, v2.id)).text;
    return { doc, v1, v2, v1t, v2t };
  };

  it('creates and reuses documents by name', async () => {
    const a = await store.getOrCreateDoc('a.md');
    const b = await store.getOrCreateDoc('a.md', '/tmp/other/a.md');
    expect(a.id).toBe(b.id);
    expect(b.path).toBe('/tmp/other/a.md');
    await expect(store.resolveDoc('nope.md')).rejects.toThrow('not found');
  });

  it('survives a concurrent-create race: the loser adopts the winner row', async () => {
    // Two connections to the same file (dev-mode double boot, two MCP clients
    // on one workspace): both SELECT (miss), both INSERT — the loser used to
    // surface a UNIQUE constraint error to the user instead of a document.
    const { DatabaseSync } = await import('node:sqlite');
    const dbPath = join(root, '.palimpsest', 'index.db');
    await (await import('node:fs/promises')).mkdir(join(root, '.palimpsest'), { recursive: true });
    const mk = () => {
      const raw = new DatabaseSync(dbPath);
      raw.exec('PRAGMA busy_timeout = 5000;');
      const db: import('../../src/history/types.js').SqliteDb = {
        async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
          return raw.prepare(sql).all(...(params as never[])) as T[];
        },
        async execute(sql: string, params: unknown[] = []) {
          const info = raw.prepare(sql).run(...(params as never[]));
          return { lastInsertId: Number(info.lastInsertRowid), changes: Number(info.changes) };
        },
      };
      return { db, close: () => raw.close() };
    };
    const a = mk();
    const b = mk();
    const storeA = createHistoryStore(a.db, fs);
    const storeB = createHistoryStore(b.db, fs);
    await storeA.init();
    await storeB.init();
    const [docA, docB] = await Promise.all([
      storeA.getOrCreateDoc('raced.md'),
      storeB.getOrCreateDoc('raced.md'),
    ]);
    expect(docA.id).toBe(docB.id);
    expect(docA.name).toBe('raced.md');
    // The store keeps working after the race
    const snap = await storeA.capture(docA.id, 'racy text', 'milestone', 'after race');
    expect((await storeA.get(docA.id, snap.id)).text).toBe('racy text');
    a.close();
    b.close();
  });

  it('writes snapshots as human-readable .md files with YAML frontmatter', async () => {
    const doc = await store.getOrCreateDoc('notes.md');
    await store.capture(doc.id, 'Hello world.', 'milestone', 'First draft', { model: 'ollama' });
    const [file] = await fs.list();
    const meta = file!.name.match(/^(\d+)-(milestone)\.md$/)?.[2];
    expect(meta).toBe('milestone');
    const raw = await readFile(
      join(root, '.palimpsest', file!.archived ? 'archive' : 'snapshots', file!.name),
      'utf8',
    );
    expect(raw).toContain('---\nid: ');
    expect(raw).toContain('doc: "notes.md"');
    expect(raw).toContain('kind: milestone');
    expect(raw).toContain('label: "First draft"');
    expect(raw).toContain('model: "ollama"');
    expect(raw).toContain('words: 2');
    expect(raw).toMatch(/Hello world\.\s*$/);
  });

  it('lists newest-first, gets text, diffs snapshot→snapshot and snapshot→current', async () => {
    const { doc, v1, v2 } = await setup();
    const list = await store.list(doc.id);
    expect(list[0]!.id).toBe(v2.id);
    expect((await store.get(doc.id, v1.id)).text).toBe(
      'The quick brown fox jumps over the lazy dog.',
    );
    const d = await store.diff(doc.id, v1.id, 'current', 'The lazy dog sleeps all day.');
    // tokens carry punctuation: "dog." vs "dog" differ, so the shared run is The+lazy
    expect(d.removed).toBe(7);
    expect(d.added).toBe(4);
    expect(d.html).toContain('<del>quick');
  });

  it('restores non-destructively: system before + milestone after', async () => {
    const { doc, v1, v2, v1t, v2t } = await setup();
    const r = await store.restore(doc.id, v1.id, v2t, 'Back to fox');
    expect(r.text).toBe(v1t);
    const list = await store.list(doc.id, 10);
    const kinds = list.slice(0, 3).map((s) => s.kind);
    expect(kinds).toEqual(['milestone', 'system', 'auto']);
    expect(list[0]!.label).toBe('Back to fox');
    expect(list[1]!.label).toBe('Before restore');
    expect((await store.get(doc.id, r.afterId)).text).toBe(v1t);
  });

  it('searches FTS across documents and history with snippets', async () => {
    const { doc, v1 } = await setup();
    await store.capture(doc.id, 'The quick brown fox escapes the hunters.', 'auto', 'rewrite');
    const hits = await store.search('fox');
    const docHit = hits.find((h) => h.source === 'document');
    const histHits = hits.filter((h) => h.source === 'history');
    expect(docHit?.snippet).toContain('[fox]');
    expect(histHits.length).toBeGreaterThan(0);
    expect(histHits.some((h) => h.snapshotId === v1.id)).toBe(true);
    expect(hits.every((h) => typeof h.status === 'string')).toBe(true);
  });

  it('recalls deleted text with status and honors the token budget', async () => {
    const doc = await store.getOrCreateDoc('novel.md');
    await store.capture(
      doc.id,
      'Chapter one: the quick brown fox chases the moon.',
      'milestone',
      'Auto captured draft',
    );
    await store.capture(
      doc.id,
      'An entirely different story about pasta and basil.',
      'auto',
      'rewrite',
    );
    const r = await store.recall('fox moon', 1000);
    const gone = r.results.find((h) => h.kind === 'history');
    expect(gone?.status).toBe('deleted');
    expect(gone?.text).toContain('brown fox');
    expect(r.tokensUsed).toBeLessThanOrEqual(1000);
    expect(gone && r.results.length === 1).toBe(true);
  });

  it('recall truncates results that would exceed the budget', async () => {
    const doc = await store.getOrCreateDoc('long.md');
    const big = 'word '.repeat(400);
    await store.capture(doc.id, `the quick brown fox ${big}`, 'milestone');
    await store.capture(doc.id, `the quick brown fox ${big} second chunk`, 'milestone');
    const r = await store.recall('quick fox', 200);
    expect(r.truncated).toBe(true);
    expect(r.results.length).toBeLessThanOrEqual(1);
    expect(r.tokensUsed).toBeLessThanOrEqual(200);
  });

  it('recall filters by document', async () => {
    const a = await store.getOrCreateDoc('a.md');
    const b = await store.getOrCreateDoc('b.md');
    await store.capture(a.id, 'brussels sprouts are green');
    await store.capture(b.id, 'brussels sprouts are green and bitter');
    const r = await store.recall('brussels', 1000, { document: 'b.md' });
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results.every((h) => h.docName === 'b.md')).toBe(true);
  });

  it('search include_deleted=false hides snapshots whose text is gone', async () => {
    const { doc } = await setup();
    const all = await store.search('fox');
    const gone = all.filter((h) => h.source === 'history' && h.status !== 'current');
    expect(gone.length).toBeGreaterThan(0);
    const live = await store.search('fox', 20, false);
    expect(live.filter((h) => h.source === 'history' && h.status !== 'current').length).toBe(0);
  });

  it('prunes auto/system to the newest KEEP_NON_MILESTONE, moving files to archive/', async () => {
    const doc = await store.getOrCreateDoc('big.md');
    for (let i = 0; i < 305; i++) {
      await store.capture(doc.id, `auto revision ${i} of the document`, 'auto');
    }
    await store.capture(doc.id, 'the keeper milestone', 'milestone', 'keep me');
    const { removed } = await store.prune(doc.id);
    expect(removed).toBeGreaterThan(0);
    const files = await fs.list();
    expect(files.filter((f) => f.archived).length).toBe(removed);
    const active = await store.list(doc.id, 1000);
    expect(active.length).toBeLessThanOrEqual(301);
    expect(active.some((s) => s.label === 'keep me')).toBe(true);
    const archived = await store.listArchived(doc.id);
    expect(archived.length).toBe(removed);
    const all = await store.listAll(doc.id, 1000);
    expect(all.length).toBe(active.length + removed);
  });

  it('recovers deleted text after index.db is destroyed: reindex() rebuilds everything', async () => {
    const { doc, v1, v2 } = await setup();
    await store.capture(doc.id, 'Final current version retained.', 'milestone', 'final');
    // simulate losing index.db: fresh in-memory db, same snapshot files on disk
    store = createHistoryStore(memoryDb(), fs);
    await store.init();
    const { docs, snapshots } = await store.reindex();
    expect(docs).toBe(1);
    expect(snapshots).toBe(3);
    const docAfter = await store.resolveDoc('notes.md');
    expect(docAfter.id).toBeGreaterThan(0);
    expect((await store.get(docAfter.id, v1.id)).text).toBe(
      'The quick brown fox jumps over the lazy dog.',
    );
    expect((await store.get(docAfter.id, v2.id)).kind).toBe('auto');
    const list = await store.list(docAfter.id, 10);
    expect(list[0]!.label).toBe('final');
    expect(list.map((s) => s.kind)).toEqual(['milestone', 'auto', 'auto']);
    const r = await store.recall('fox');
    expect(r.results.some((h) => h.kind === 'history' && h.status === 'deleted')).toBe(true);
    const s = await store.search('fox');
    expect(s.length).toBeGreaterThan(0);
  });

  it('reindex is idempotent', async () => {
    const { doc } = await setup();
    await store.capture(doc.id, 'a third revision worth remembering', 'milestone', 'three');
    const first = await store.reindex();
    store = createHistoryStore(memoryDb(), fs);
    await store.init();
    const second = await store.reindex();
    expect(second.snapshots).toBe(first.snapshots);
    expect(second.docs).toBe(first.docs);
  });

  it('renames a milestone label in place', async () => {
    const { doc } = await setup();
    const m = await store.capture(doc.id, 'Milestone text.', 'milestone', 'Old name');
    await store.renameSnapshot(doc.id, m.id, 'New name');
    const list = await store.list(doc.id);
    expect(list.find((s) => s.id === m.id)!.label).toBe('New name');
    const raw = await readFile(
      join(root, '.palimpsest', 'snapshots', `${m.id}-milestone.md`),
      'utf8',
    );
    expect(raw).toContain('label: "New name"');
    expect(raw).toContain('Milestone text.');
  });

  it('list marks snapshots current/modified/deleted vs the current text', async () => {
    const doc = await store.getOrCreateDoc('status.md');
    const a = await store.capture(doc.id, 'The quick brown fox.', 'auto', 'a');
    const b = await store.capture(doc.id, 'The lazy dog sleeps.', 'auto', 'b');
    const c = await store.capture(doc.id, 'A totally different topic.', 'milestone', 'c');
    const statuses = new Map((await store.list(doc.id)).map((s) => [s.id, s.status]));
    expect(statuses.get(a.id)).toBe('deleted');
    expect(statuses.get(b.id)).toBe('deleted');
    expect(statuses.get(c.id)).toBe('current');
    await store.capture(doc.id, 'The quick brown fox.', 'milestone', 'a again');
    const after = new Map((await store.list(doc.id)).map((s) => [s.id, s.status]));
    expect(after.get(a.id)).toBe('current');
  });

  it('reports stats and snapshot counts', async () => {
    const { doc } = await setup();
    const s = await store.stats(doc.id, 'The lazy dog sleeps all day.');
    expect(s.words).toBe(6);
    expect(s.readingMinutes).toBeGreaterThanOrEqual(1);
    expect(s.snapshotCount).toBe(2);
  });

  it('reconcile captures external changes and no-ops on identical text', async () => {
    const { doc } = await setup();
    const before = await store.list(doc.id);
    expect(await store.reconcile(doc.id, 'The lazy dog sleeps all day.')).toBeNull();
    const captured = await store.reconcile(doc.id, 'Edited outside Palimpsest.');
    expect(captured).not.toBeNull();
    expect(captured!.kind).toBe('auto');
    expect(captured!.label).toBe('external change');
    expect((await store.get(doc.id, captured!.id)).text).toBe('Edited outside Palimpsest.');
    expect(await store.reconcile(doc.id, 'Edited outside Palimpsest.')).toBeNull();
    expect((await store.list(doc.id)).length).toBe(before.length + 1);
  });

  it('reconcile seeds the first snapshot when none exists', async () => {
    const doc = await store.getOrCreateDoc('fresh.md');
    const snap = await store.reconcile(doc.id, 'First content.');
    expect(snap).not.toBeNull();
    expect(snap!.label).toBe('initial');
  });
});
