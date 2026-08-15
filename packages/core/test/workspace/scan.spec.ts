import { describe, expect, it } from 'vitest';
import { listMarkdownDocs, type DirEntry } from '../../src/workspace/scan.js';

const ROOT = 'ws';
const tree = new Map<string, DirEntry[]>([
  [ROOT, [
    { name: 'notes.md', isDir: false },
    { name: '.hidden.md', isDir: false },
    { name: 'a', isDir: true },
    { name: '.palimpsest', isDir: true },
    { name: 'empty', isDir: true },
    { name: 'node_modules', isDir: true },
  ]],
  [`${ROOT}/a`, [
    { name: 'b.md', isDir: false },
    { name: 'c', isDir: true },
  ]],
  [`${ROOT}/a/c`, [{ name: 'd.md', isDir: false }]],
  [`${ROOT}/.palimpsest`, [{ name: 'snapshots', isDir: true }]],
  [`${ROOT}/.palimpsest/snapshots`, [{ name: '1-auto.md', isDir: false }]],
  [`${ROOT}/empty`, []],
  [`${ROOT}/node_modules`, [{ name: 'README.md', isDir: false }]],
]);

const readDir = async (dir: string): Promise<DirEntry[]> => tree.get(dir) ?? [];

describe('listMarkdownDocs', () => {
  it('finds root and nested .md files, skips dot-dirs and dot-files, sorted', async () => {
    expect(await listMarkdownDocs(ROOT, readDir)).toEqual(['a/b.md', 'a/c/d.md', 'notes.md']);
  });

  it('handles an empty or missing root', async () => {
    expect(await listMarkdownDocs('missing', readDir)).toEqual([]);
    expect(await listMarkdownDocs(ROOT, async () => [])).toEqual([]);
  });

  it('tolerates read failure in a subdirectory without aborting', async () => {
    const failing: typeof readDir = async (dir) =>
      dir === `${ROOT}/a` ? Promise.reject(new Error('EACCES')) : readDir(dir);
    expect(await listMarkdownDocs(ROOT, failing)).toEqual(['notes.md']);
  });
});
