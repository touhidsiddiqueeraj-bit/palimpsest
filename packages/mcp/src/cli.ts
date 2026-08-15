#!/usr/bin/env node
/**
 * Palimpsest MCP server CLI — runs the capability-layer server against a real
 * markdown workspace (default: cwd) and serves it over stdio or HTTP.
 *
 *   node dist/cli.mjs [--workspace <dir>] [--port <n>]
 *
 * Env (all optional):
 *   PALIMPSEST_PROVIDER_URL  provider base URL -> makes apply_edit usable
 *   PALIMPSEST_MODEL         model id (default: provider default)
 *   PALIMPSEST_LOCAL_ONLY    '0' turns off the local-only gate: apply_edit may
 *                            use any configured provider, or accept agent-supplied
 *                            content when no provider URL is set (default: '1')
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHistoryStore, listMarkdownDocs, type Readdir, type SqliteDb, type SnapshotFs } from '@palimpsest/core';
import { createClient, isLocalUrl, type AiClient } from '@palimpsest/ai';
import { runStdioServer, runHttpServer, type McpContext } from './index.js';

function nodeDb(dbPath: string): SqliteDb {
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL;');
  return {
    async select<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const r = raw.prepare(sql).run(...(params as never[]));
      return { lastInsertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    },
  };
}

function nodeSnapshotFs(snapDir: string): SnapshotFs {
  const archDir = join(snapDir, 'archive');
  return {
    async list() {
      const live = (await safeReaddir(snapDir)).map((name) => ({ name, archived: false }));
      const archived = (await safeReaddir(archDir)).map((name) => ({ name, archived: true }));
      return [...live, ...archived];
    },
    async read(name: string, archived: boolean) {
      return readFile(join(archived ? archDir : snapDir, name), 'utf8');
    },
    async write(name: string, text: string) {
      const target = join(snapDir, name);
      const tmp = target + '.tmp';
      await mkdir(dirname(target), { recursive: true });
      await writeFile(tmp, text);
      await rename(tmp, target);
    },
    async moveToArchive(name: string) {
      await mkdir(archDir, { recursive: true });
      await rename(join(snapDir, name), join(archDir, name));
    },
  };
}

const safeReaddir = async (dir: string): Promise<string[]> => {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
};

const nodeReaddir: Readdir = async (dir: string) => {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }
};

/** Register every workspace .md and seed its first snapshot so history tools work from day one. */
async function bootstrap(store: ReturnType<typeof createHistoryStore>, ws: string): Promise<void> {
  const docs = await listMarkdownDocs(ws, nodeReaddir);
  for (const name of docs) {
    const doc = await store.getOrCreateDoc(name, name);
    const existing = await store.list(doc.id);
    if (existing.length === 0) {
      const text = await readFile(join(ws, name), 'utf8');
      if (text.trim()) await store.capture(doc.id, text, 'auto', 'seed');
    }
  }
}

const USAGE = `palimpsest — MCP server for a markdown workspace

Usage:
  node cli.cjs [--workspace <dir>] [--port <n>]   run the MCP server (stdio; HTTP when --port)
  node cli.cjs --help                             this help
  node cli.cjs --version                          version

Options:
  --workspace <dir>   workspace root (default: current directory; every existing
                      .md file is registered with history at startup)
  --port <n>          serve over HTTP on this port instead of stdio

Env:
  PALIMPSEST_PROVIDER_URL   LLM base URL -> enables apply_edit
  PALIMPSEST_MODEL          model id (default: provider default)
  PALIMPSEST_LOCAL_ONLY     '0' turns off the local-only gate: apply_edit may
                            use any configured provider, or accept agent-supplied
                            content when no provider URL is set (default: '1')

New documents: create empty .md files in the workspace, or call the MCP
create_doc tool — no AI provider is needed for either.
apply_edit: needs a local provider while local-only is on; with local-only
off it runs against any provider, or applies agent-supplied 'content' directly
(every edit is captured as a before-snapshot + milestone).
External file edits (agent, git, other editors) are captured as auto snapshots
when a doc is opened or a milestone is requested; create_milestone on an
unchanged doc attaches the label to its latest snapshot (reused_snapshot:
true) instead of no-op'ing.
Document names in tools accept with or without the '.md' suffix; get_stats
without a doc measures notes.md (or the first .md in the workspace) and
names it in the response.
`;

export async function main(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log('palimpsest 0.1.0');
    return;
  }
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    if (argv[i]?.startsWith('--')) args.set(argv[i]!.slice(2), argv[i + 1] ?? '');
  }
  const ws = resolve(args.get('workspace') ?? process.cwd());
  const metaDir = join(ws, '.palimpsest');
  await mkdir(join(metaDir, 'snapshots', 'archive'), { recursive: true });

  const store = createHistoryStore(
    nodeDb(join(metaDir, 'index.db')),
    nodeSnapshotFs(join(metaDir, 'snapshots')),
  );
  await store.init();
  await bootstrap(store, ws);

  const providerUrl = process.env.PALIMPSEST_PROVIDER_URL;
  const localOnly = process.env.PALIMPSEST_LOCAL_ONLY !== '0';
  const ai: AiClient | undefined = providerUrl
    ? createClient(
        {
          id: 'mcp',
          kind: isLocalUrl(providerUrl) ? 'ollama' : 'openai',
          baseUrl: providerUrl,
          model: process.env.PALIMPSEST_MODEL ?? 'default',
        },
        { localOnly },
      )
    : undefined;

  const ctx: McpContext = { store, workspace: ws, ai, localOnly };

  const port = Number(args.get('port'));
  if (Number.isFinite(port) && port > 0) {
    await runHttpServer(ctx, port);
    console.error(`palimpsest mcp listening on http://127.0.0.1:${port}`);
    await new Promise<never>(() => {});
  } else {
    await runStdioServer(ctx);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error('palimpsest mcp failed:', err);
  process.exit(1);
});
