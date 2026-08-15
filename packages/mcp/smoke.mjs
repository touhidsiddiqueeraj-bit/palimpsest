/* Manual smoke: spawn the real CLI and drive it like an agent would. */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { McpClient } from './src/client.ts';

const WS = '/tmp/opencode/md-ws';
mkdirSync(`${WS}/docs`, { recursive: true });
writeFileSync(`${WS}/notes.md`, '# Alpha\n\nFirst notes for the palimpsest round trip.\n');
writeFileSync(`${WS}/docs/one.md`, '# Beta\n');

const ALL = [
  'recall',
  'get_outline',
  'get_document',
  'get_stats',
  'create_doc',
  'create_milestone',
  'restore_version',
  'apply_edit',
];
let ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`);
  if (!cond) process.exitCode = 1;
};

const main = async () => {
  const cli = '/home/touhid/Documents/markdown/packages/mcp/dist/cli.cjs';
  const client = McpClient.stdio('node', [cli, '--workspace', WS], {
    allowlist: ALL,
  });
  await client.connect();

  const stats = await client.call('get_stats');
  ok('get_stats', stats.words > 0 && typeof stats.tokens_used === 'number', JSON.stringify(stats));

  const doc = await client.call('get_document', { doc: 'notes.md' });
  ok('get_document', String(doc.text).includes('Alpha'), JSON.stringify(doc));

  const outline = await client.call('get_outline', { doc: 'docs/one.md' });
  ok('get_outline', outline.outline?.[0]?.text === 'Beta', JSON.stringify(outline));

  const recall = await client.call('recall', { query: 'palimpsest' });
  ok(
    'recall',
    recall.results.length > 0 && recall.results.some((h) => h.status === 'current'),
    JSON.stringify(recall.results?.[0] ?? {}),
  );

  const dry = await client.call('create_milestone', {
    doc: 'notes.md',
    label: 'smoke',
    dry_run: true,
  });
  ok('milestone dry_run', dry.dry_run === true, JSON.stringify(dry));

  const unchanged = await client.call('create_milestone', { doc: 'notes.md', label: 'smoke' });
  ok('milestone no-op on unchanged', unchanged.noop === true, JSON.stringify(unchanged));

  appendFileSync(`${WS}/notes.md`, 'External edit before the milestone.\n');
  const real = await client.call('create_milestone', { doc: 'notes.md', label: 'smoke' });
  ok('milestone real', Number(real.snapshot_id) > 0, JSON.stringify(real));

  const restore = await client.call('restore_version', {
    doc: 'notes.md',
    snapshot_id: real.snapshot_id,
    dry_run: true,
  });
  ok('restore dry_run', restore.dry_run === true, JSON.stringify(restore));

  const made = await client.call('create_doc', { doc: 'smoke-new.md' });
  ok('create_doc', made.created === true && Number(made.doc_id) > 0, JSON.stringify(made));
  const again = await client.call('create_doc', { doc: 'smoke-new.md' });
  ok('create_doc idempotent', again.created === false, JSON.stringify(again));
  const bare = await client.call('get_document', { doc: 'smoke-new' });
  ok('bare-name lookup', String(bare.text).includes('# smoke-new'), JSON.stringify(bare));
  const missing = String(await client.call('get_stats', { doc: 'nonexistent_doc_test' }));
  ok('get_stats strict', missing.includes('create_doc'), missing.slice(0, 80));

  const aiError = String(
    await client.call('apply_edit', { doc: 'notes.md', instruction: 'tweak', dry_run: true }),
  );
  ok(
    'apply_edit guards local-only without AI',
    aiError.includes('no local AI provider configured'),
    aiError.slice(0, 80),
  );

  await client.close();
  console.log(process.exitCode === 1 ? 'SMOKE FAILED' : 'SMOKE OK');
};
main().catch((e) => {
  console.error('SMOKE ERROR', e);
  process.exit(1);
});
