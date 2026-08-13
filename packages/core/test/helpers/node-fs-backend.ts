import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SnapshotFs } from '../../src/history/types.js';

/** node:fs SnapshotFs for unit tests — mirrors what Tauri's fs plugin will do in the app. */
export function nodeSnapshotFs(root: string): SnapshotFs {
  const live = join(root, '.palimpsest', 'snapshots');
  const archive = join(root, '.palimpsest', 'archive');
  const ensure = (d: string) => mkdir(d, { recursive: true });

  return {
    async list() {
      const out: { name: string; archived: boolean }[] = [];
      for (const [dir, archived] of [
        [live, false],
        [archive, true],
      ] as const) {
        try {
          for (const e of await readdir(dir)) out.push({ name: e, archived });
        } catch {
          // dir not created yet
        }
      }
      return out;
    },
    async read(name, archived) {
      return readFile(join(archived ? archive : live, name), 'utf8');
    },
    async write(name, text) {
      await ensure(live);
      const final = join(live, name);
      const tmp = final + '.tmp';
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, final); // atomic on same fs
    },
    async moveToArchive(name) {
      await ensure(archive);
      await rename(join(live, name), join(archive, name));
    },
  };
}
