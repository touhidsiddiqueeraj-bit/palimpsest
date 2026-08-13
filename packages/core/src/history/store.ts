import { diffProse, renderDiffHtml, countWords } from '../diff/index.js';
import { KEEP_NON_MILESTONE } from './config.js';
import { encodeSnapshotFile, makeFrontmatter, parseSnapshotFile } from './frontmatter.js';
import type {
  DocumentInfo,
  RecallHit,
  RecallOptions,
  RecallResult,
  SearchHit,
  SnapshotFs,
  SnapshotInfo,
  SnapshotKind,
  SnapshotMeta,
  SnapshotStatus,
  SqliteDb,
} from './types.js';

export interface SnapshotWithText extends SnapshotInfo {
  text: string;
}

export interface DocDiff {
  fromText: string;
  toText: string;
  added: number;
  removed: number;
  html: string;
}

/**
 * .palimpsest/
 *   index.db            derived, rebuildable (reindex()); deleting it loses nothing
 *   snapshots/<ts>-<kind>.md   immutable snapshot files = source of truth
 *   archive/<ts>-<kind>.md     pruned auto/system snapshots
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  path TEXT,
  text TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  file TEXT NOT NULL UNIQUE,
  archived INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL CHECK (kind IN ('auto','system','ai','milestone')),
  label TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  words INTEGER NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_doc ON snapshots(doc_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_kind ON snapshots(doc_id, kind, ts DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
  text, snapshot_id UNINDEXED, doc_id UNINDEXED, tokenize='porter'
);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  name, text, doc_id UNINDEXED, tokenize='porter'
);
`;

const tokenize = (q: string) =>
  q
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)
    ?.slice(0, 16) ?? [];

/** FTS MATCH expression: quoted terms ANDed — safe against OR/AND/- user input. */
const ftsQuery = (q: string) =>
  tokenize(q)
    .map((t) => `"${t}"`)
    .join(' AND ');

/** ~4 chars/token — the honest heuristic for budget math (spec Appendix D). */
const tokens = (s: string) => Math.ceil(s.length / 4);

/** ~60 chars around the first matching term, [term] highlighted (JS-side; FTS5 aux
 * functions like snippet()/bm25() don't work through join aliases in all drivers). */
function makeSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  const radius = 60;
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, radius * 2) + (text.length > radius * 2 ? '…' : '');
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  const term = text.slice(at, at + (terms.find((t) => lower.indexOf(t) === at)?.length ?? 0));
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return (
    prefix + text.slice(start, at) + '[' + term + ']' + text.slice(at + term.length, end) + suffix
  );
}

export function createHistoryStore(db: SqliteDb, fs: SnapshotFs) {
  async function init(): Promise<void> {
    for (const stmt of SCHEMA.split(';').filter((s) => s.trim())) {
      await db.execute(stmt);
    }
  }

  async function getOrCreateDoc(name: string, path?: string): Promise<DocumentInfo> {
    const now = Date.now();
    const rows = await db.select<DocumentInfo>(
      'SELECT id, name, path, created, updated FROM documents WHERE name = ?',
      [name],
    );
    if (rows[0]) {
      const doc = rows[0];
      await db.execute('UPDATE documents SET updated = ?, path = COALESCE(?, path) WHERE id = ?', [
        now,
        path ?? null,
        doc.id,
      ]);
      return { ...doc, path: path ?? doc.path, updated: now };
    }
    const r = await db.execute(
      'INSERT INTO documents (name, path, text, created, updated) VALUES (?, ?, ?, ?, ?)',
      [name, path ?? null, '', now, now],
    );
    return { id: Number(r.lastInsertId), name, path: path ?? null, created: now, updated: now };
  }

  /** Write an immutable snapshot file, then index it. */
  async function capture(
    docId: number,
    text: string,
    kind: SnapshotKind = 'auto',
    label = '',
    meta: SnapshotMeta = {},
  ): Promise<SnapshotInfo> {
    const ts = Date.now();
    const { name: docName } = await resolveDoc(docId);
    let id = ts;
    // ponytail: id doubles as timestamp; bump on collision with an existing file or index row
    let name = `${id}-${kind}.md`;
    const taken = async (i: number, n: string) =>
      (await db.select('SELECT 1 FROM snapshots WHERE id = ?', [i])).length > 0 ||
      (await fs.list()).some((f) => f.name === n && !f.archived);
    while (await taken(id, name)) {
      id++;
      name = `${id}-${kind}.md`;
    }
    await fs.write(
      name,
      encodeSnapshotFile(makeFrontmatter(id, docName, ts, kind, label, meta, text), text),
    );
    await indexSnapshot(id, docId, name, kind, label, meta, text, ts, false);
    return { id, docId, kind, label, meta, words: countWords(text), ts, archived: false };
  }

  async function indexSnapshot(
    id: number,
    docId: number,
    file: string,
    kind: SnapshotKind,
    label: string,
    meta: SnapshotMeta,
    text: string,
    ts: number,
    archived: boolean,
  ): Promise<void> {
    await db.execute(
      'INSERT INTO snapshots (id, doc_id, file, archived, kind, label, meta, words, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, docId, file, archived ? 1 : 0, kind, label, JSON.stringify(meta), countWords(text), ts],
    );
    await db.execute(
      'INSERT INTO history_fts (rowid, text, snapshot_id, doc_id) VALUES (?, ?, ?, ?)',
      [id, text, id, docId],
    );
    await db.execute('UPDATE documents SET text = ?, updated = ? WHERE id = ?', [text, ts, docId]);
    await db.execute('DELETE FROM documents_fts WHERE doc_id = ?', [docId]);
    await db.execute('INSERT INTO documents_fts (rowid, doc_id, name, text) VALUES (?, ?, ?, ?)', [
      docId,
      docId,
      (await resolveDoc(docId)).name,
      text,
    ]);
  }

  /** Rebuild documents/snapshots/FTS entirely from the snapshot files on disk. */
  async function reindex(): Promise<{ docs: number; snapshots: number }> {
    await db.execute('DELETE FROM snapshots');
    await db.execute('DELETE FROM documents_fts');
    await db.execute('DELETE FROM history_fts');
    await db.execute('DELETE FROM documents');
    const files = await fs.list();
    const docIds = new Map<string, number>();
    let snapshots = 0;
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      const content = await fs.read(f.name, f.archived);
      const { fm, text } = parseSnapshotFile(content);
      if (!fm.doc) continue;
      let docId = docIds.get(fm.doc);
      if (docId === undefined) {
        const now = Date.now();
        const r = await db.execute(
          'INSERT INTO documents (name, path, text, created, updated) VALUES (?, NULL, ?, ?, ?)',
          [fm.doc, text, Math.min(now, fm.ts), now],
        );
        docId = Number(r.lastInsertId);
        docIds.set(fm.doc, docId);
      } else {
        await db.execute('UPDATE documents SET updated = MAX(updated, ?), text = ? WHERE id = ?', [
          fm.ts,
          text,
          docId,
        ]);
      }
      await indexSnapshot(
        fm.id,
        docId,
        f.name,
        fm.kind,
        fm.label,
        {
          model: fm.model,
          instruction: fm.instruction,
        },
        text,
        fm.ts,
        f.archived,
      );
      snapshots++;
    }
    return { docs: docIds.size, snapshots };
  }

  async function list(docId: number, limit = 300): Promise<SnapshotInfo[]> {
    return listFrom('snapshots', docId, limit);
  }

  async function listFrom(
    which: 'snapshots' | 'archive' | 'all',
    docId: number,
    limit = 300,
  ): Promise<SnapshotInfo[]> {
    const archived = which === 'archive' ? '= 1' : which === 'snapshots' ? '= 0' : 'IN (0,1)';
    const rows = await db.select<SnapshotInfo & { meta: string }>(
      `SELECT id, doc_id AS docId, kind, label, meta, words, ts, archived FROM snapshots
       WHERE doc_id = ? AND archived ${archived} ORDER BY ts DESC, id DESC LIMIT ?`,
      [docId, limit],
    );
    return rows.map((r) => ({
      ...r,
      archived: Boolean(r.archived),
      meta: JSON.parse(r.meta || '{}') as SnapshotMeta,
    }));
  }

  async function get(docId: number, snapshotId: number): Promise<SnapshotWithText> {
    const rows = await db.select<SnapshotInfo & { meta: string; text: string }>(
      `SELECT s.id, s.doc_id AS docId, s.kind, s.label, s.meta, s.words, s.ts, s.archived,
              h.text FROM snapshots s JOIN history_fts h ON h.rowid = s.id
       WHERE s.doc_id = ? AND s.id = ?`,
      [docId, snapshotId],
    );
    const r = rows[0];
    if (!r) throw new Error(`snapshot ${snapshotId} not found for doc ${docId}`);
    return {
      ...r,
      archived: Boolean(r.archived),
      meta: JSON.parse(r.meta || '{}') as SnapshotMeta,
    };
  }

  /** Word diff between two snapshots (or a snapshot and the current text). */
  async function diff(
    docId: number,
    fromId: number,
    to: number | 'current',
    currentText?: string,
  ): Promise<DocDiff> {
    const from = await get(docId, fromId);
    const toText = to === 'current' ? (currentText ?? '') : (await get(docId, to)).text;
    const r = diffProse(from.text, toText);
    return {
      fromText: from.text,
      toText,
      added: r.added,
      removed: r.removed,
      html: renderDiffHtml(r.ops),
    };
  }

  /** Non-destructive restore: system snapshot of current text before, milestone after. */
  async function restore(
    docId: number,
    snapshotId: number,
    currentText: string,
    label = '',
  ): Promise<{ text: string; beforeId: number; afterId: number }> {
    const snap = await get(docId, snapshotId);
    const before = await capture(docId, currentText, 'system', 'Before restore');
    const after = await capture(
      docId,
      snap.text,
      'milestone',
      label || `Restored · ${snap.label || snap.kind}`,
    );
    return { text: snap.text, beforeId: before.id, afterId: after.id };
  }

  /** FTS across documents and history; fallback to LIKE on query errors. */
  async function search(query: string, limit = 20, includeDeleted = true): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const hits: SearchHit[] = [];
    const fq = ftsQuery(q);
    if (!fq) return [];
    const like = `%${q}%`;
    let docs: Array<{ docId: number; name: string; text: string }>;
    let hist: Array<{
      docId: number;
      docName: string;
      snapshotId: number;
      kind: SnapshotKind;
      ts: number;
      text: string;
      archived: boolean;
    }>;
    try {
      docs = await db.select(
        `SELECT d.id AS docId, d.name AS name, d.text AS text
         FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
         WHERE documents_fts MATCH ? ORDER BY rank LIMIT ?`,
        [fq, limit],
      );
      hist = await db.select(
        `SELECT h.doc_id AS docId, d.name AS docName, h.snapshot_id AS snapshotId, s.kind AS kind, s.ts AS ts,
                h.text AS text, s.archived AS archived
         FROM history_fts h JOIN snapshots s ON s.id = h.rowid JOIN documents d ON d.id = h.doc_id
         WHERE history_fts MATCH ? ORDER BY rank LIMIT ?`,
        [fq, limit * 2],
      );
    } catch {
      docs = await db.select(
        `SELECT d.id AS docId, d.name AS name, d.text AS text FROM documents d WHERE d.text LIKE ? OR d.name LIKE ? LIMIT ?`,
        [like, like, limit],
      );
      hist = await db.select(
        `SELECT h.doc_id AS docId, d.name AS docName, h.snapshot_id AS snapshotId, s.kind AS kind, s.ts AS ts,
                h.text AS text, s.archived AS archived
         FROM history_fts h JOIN snapshots s ON s.id = h.rowid JOIN documents d ON d.id = h.doc_id
         WHERE h.text LIKE ? LIMIT ?`,
        [like, limit * 2],
      );
    }
    for (const d of docs)
      hits.push({
        source: 'document',
        docId: d.docId,
        docName: d.name,
        snippet: makeSnippet(d.text, tokenize(q)),
        status: 'current',
      });
    const current = new Map<number, string>(
      (await db.select<{ id: number; text: string }>('SELECT id, text FROM documents')).map((r) => [
        r.id,
        r.text,
      ]),
    );
    for (const h of hist) {
      const status = statusOf(
        h.docId,
        current.get(h.docId) ?? '',
        await snapshotText(h.docId, h.snapshotId),
      );
      if (!includeDeleted && status !== 'current') continue;
      hits.push({
        source: 'history',
        docId: h.docId,
        docName: h.docName,
        snippet: makeSnippet(h.text, tokenize(q)),
        snapshotId: h.snapshotId,
        kind: h.kind,
        ts: h.ts,
        archived: Boolean(h.archived),
        status,
      });
    }
    return hits.slice(0, limit * 2);
  }

  /**
   * Budget-bounded memory recall (spec Appendix D): relevance-ranked results
   * whose full texts never exceed token_budget; truncated when cut.
   */
  async function recall(
    query: string,
    tokenBudget = 4096,
    opts: RecallOptions = {},
  ): Promise<RecallResult> {
    const fq = ftsQuery(query);
    const results: RecallHit[] = [];
    let tokensUsed = 0;
    let truncated = false;

    const current = new Map<number, string>(
      (await db.select<{ id: number; text: string }>('SELECT id, text FROM documents')).map((r) => [
        r.id,
        r.text,
      ]),
    );

    if (fq) {
      const scopeSql = opts.document ? ' AND d.name = ?' : '';
      try {
        const docs = await db.select<{ docId: number; docName: string; text: string }>(
          `SELECT d.id AS docId, d.name AS docName, d.text AS text
           FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid
           WHERE documents_fts MATCH ?${scopeSql} ORDER BY rank LIMIT 6`,
          opts.document ? [fq, opts.document] : [fq],
        );
        for (const d of docs) {
          if (opts.scope && !opts.scope.includes(d.docName)) continue;
          results.push({
            kind: 'document',
            docId: d.docId,
            docName: d.docName,
            text: d.text,
            snippet: makeSnippet(d.text, tokenize(query)),
            status: 'current',
          });
        }
        const hist = await db.select<{
          docId: number;
          docName: string;
          snapshotId: number;
          ts: number;
          text: string;
        }>(
          `SELECT h.doc_id AS docId, d.name AS docName, h.snapshot_id AS snapshotId, s.ts AS ts, h.text AS text
           FROM history_fts h JOIN snapshots s ON s.id = h.rowid JOIN documents d ON d.id = h.doc_id
           WHERE history_fts MATCH ?${scopeSql} ORDER BY rank LIMIT 12`,
          opts.document ? [fq, opts.document] : [fq],
        );
        for (const h of hist) {
          const status = statusOf(h.docId, current.get(h.docId) ?? '', h.text);
          if (opts.include && !opts.include.includes(status)) continue;
          if (opts.scope && !opts.scope.includes(h.docName)) continue;
          results.push({
            kind: 'history',
            docId: h.docId,
            docName: h.docName,
            text: h.text,
            snippet: makeSnippet(h.text, tokenize(query)),
            status,
            snapshotId: h.snapshotId,
            ts: h.ts,
          });
        }
      } catch {
        // fall through to budget packing with whatever ranked (empty) results exist
      }
    }

    const filtered = results;
    const packed: RecallHit[] = [];
    for (const hit of filtered) {
      const cost = tokens(hit.text);
      if (packed.length > 0 && tokensUsed + cost > tokenBudget) {
        truncated = true;
        continue;
      }
      packed.push(hit);
      tokensUsed += cost;
    }
    // ponytail: a lone hit may exceed budget — never return an empty bundle
    if (packed.length === 0 && filtered[0]) {
      packed.push(filtered[0]);
      tokensUsed = tokens(filtered[0].text);
    }
    return { results: packed, tokensUsed: Math.min(tokensUsed, tokenBudget), truncated };
  }

  const statusOf = (docId: number, currentText: string, snapshotText: string): SnapshotStatus => {
    if (snapshotText === currentText) return 'current';
    return overlap(snapshotText, currentText) > 0 ? 'modified' : 'deleted';
  };

  async function snapshotText(docId: number, snapshotId: number): Promise<string> {
    const rows = await db.select<{ text: string }>('SELECT text FROM history_fts WHERE rowid = ?', [
      snapshotId,
    ]);
    return rows[0]?.text ?? '';
  }

  /** Word-overlap ratio in (0,1]; 0 = no shared words. */
  function overlap(a: string, b: string): number {
    const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
    const wa = words(a);
    if (wa.size === 0) return 0;
    let shared = 0;
    for (const w of words(b)) if (wa.has(w)) shared++;
    return shared / wa.size;
  }

  /** Move retired auto/system snapshots (newest K kept) to archive/. */
  async function prune(docId: number): Promise<{ removed: number }> {
    const rows = await db.select<{ id: number; file: string }>(
      `SELECT id, file FROM snapshots WHERE doc_id = ? AND kind IN ('auto','system') AND archived = 0
       ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ${KEEP_NON_MILESTONE}`,
      [docId],
    );
    for (const row of rows) {
      await fs.moveToArchive(row.file);
      await db.execute('UPDATE snapshots SET archived = 1 WHERE id = ?', [row.id]);
    }
    return { removed: rows.length };
  }

  async function stats(
    docId: number,
    currentText: string,
  ): Promise<{ words: number; chars: number; readingMinutes: number; snapshotCount: number }> {
    const words = countWords(currentText);
    const count = (
      await db.select<{ n: number }>('SELECT COUNT(*) AS n FROM snapshots WHERE doc_id = ?', [
        docId,
      ])
    )[0];
    return {
      words,
      chars: currentText.length,
      readingMinutes: Math.max(1, Math.ceil(words / 220)),
      snapshotCount: count?.n ?? 0,
    };
  }

  async function resolveDoc(idOrName: string | number): Promise<DocumentInfo> {
    const rows =
      typeof idOrName === 'number'
        ? await db.select<DocumentInfo>(
            'SELECT id, name, path, created, updated FROM documents WHERE id = ?',
            [idOrName],
          )
        : await db.select<DocumentInfo>(
            'SELECT id, name, path, created, updated FROM documents WHERE name = ?',
            [idOrName],
          );
    const doc = rows[0];
    if (!doc) throw new Error(`document not found: ${idOrName}`);
    return doc;
  }

  return {
    init,
    getOrCreateDoc,
    capture,
    list,
    listAll: (docId: number, limit = 300) => listFrom('all', docId, limit),
    listArchived: (docId: number, limit = 300) => listFrom('archive', docId, limit),
    get,
    diff,
    restore,
    search,
    recall,
    prune,
    stats,
    resolveDoc,
    reindex,
  };
}

export type HistoryStore = ReturnType<typeof createHistoryStore>;
