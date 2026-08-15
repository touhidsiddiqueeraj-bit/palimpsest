export interface DirEntry {
  name: string;
  isDir: boolean;
}

export type Readdir = (dir: string) => Promise<DirEntry[]>;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'target',
  'build',
  'out',
  'coverage',
  'venv',
  '.venv',
  'test-results',
  'playwright-report',
]);

/**
 * Walk a workspace recursively and return every `.md` file as a workspace-relative
 * path (`folder/name.md`), sorted. Dot-directories (`.palimpsest`, `.git`),
 * dot-files and well-known build/dependency dirs are skipped so history trees and
 * artifacts never surface as documents. Hosts inject their own `readDir`
 * (tauri plugin-fs, node:fs, …) — this module has no I/O.
 */
export async function listMarkdownDocs(root: string, readDir: Readdir): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: DirEntry[];
    try {
      entries = await readDir(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const full = `${dir}/${e.name}`;
      if (e.isDir) {
        await walk(full);
      } else if (e.name.endsWith('.md')) {
        out.push(full.slice(root.length + 1));
      }
    }
  };
  await walk(root);
  return out.sort();
}
