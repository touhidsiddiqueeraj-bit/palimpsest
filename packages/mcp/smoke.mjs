/* Manual smoke: spawn the real CLI and drive it like an agent would. */
import { McpClient } from './src/client.js';

const ALL = [
  'recall',
  'get_outline',
  'get_document',
  'get_stats',
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
  const client = McpClient.stdio('node', [cli, '--workspace', '/tmp/opencode/md-ws'], {
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
  const real = await client.call('create_milestone', { doc: 'notes.md', label: 'smoke' });
  ok('milestone real', Number(real.snapshot_id) > 0, JSON.stringify(real));

  const restore = await client.call('restore_version', {
    doc: 'notes.md',
    snapshot_id: real.snapshot_id,
    dry_run: true,
  });
  ok('restore dry_run', restore.dry_run === true, JSON.stringify(restore));

  const aiError = String(
    await client.call('apply_edit', { doc: 'notes.md', instruction: 'tweak', dry_run: true }),
  );
  ok(
    'apply_edit guards missing AI',
    aiError.includes('no AI provider configured'),
    aiError.slice(0, 60),
  );

  await client.close();
  console.log(process.exitCode === 1 ? 'SMOKE FAILED' : 'SMOKE OK');
};
main().catch((e) => {
  console.error('SMOKE ERROR', e);
  process.exit(1);
});
