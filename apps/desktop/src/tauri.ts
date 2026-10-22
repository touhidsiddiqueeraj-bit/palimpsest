import Database from '@tauri-apps/plugin-sql';
import { mkdir, readDir, readTextFile, rename, writeTextFile } from '@tauri-apps/plugin-fs';
import type { SnapshotFs, SqliteDb } from '@palimpsest/core';

/** tauri-plugin-sql behind core's SqliteDb interface. */
export async function sqliteDb(path: string): Promise<SqliteDb> {
  const db = await Database.load(`sqlite:${path}`);
  return {
    async select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
      return (await db.select(sql, params ?? [])) as T[];
    },
    async execute(
      sql: string,
      params?: unknown[],
    ): Promise<{ lastInsertId: number; changes: number }> {
      const r = await db.execute(sql, params ?? []);
      return { lastInsertId: Number(r.lastInsertId), changes: r.rowsAffected ?? 0 };
    },
  };
}

const snapshotsDir = (root: string) => `${root}/.palimpsest/snapshots`;
const archiveDir = (root: string) => `${root}/.palimpsest/archive`;

/** tauri-plugin-fs behind core's SnapshotFs interface. */
export function snapshotFs(root: string): SnapshotFs {
  const live = snapshotsDir(root);
  const archive = archiveDir(root);
  return {
    async list() {
      const out: { name: string; archived: boolean }[] = [];
      for (const [dir, archived] of [
        [live, false],
        [archive, true],
      ] as const) {
        try {
          // Files only: a stray directory inside snapshots/ (e.g. left by an
          // older MCP CLI that archived there) used to surface as a live
          // snapshot name and made reindex() fail with EISDIR.
          for (const e of await readDir(dir)) {
            if (!e.isDirectory) out.push({ name: e.name, archived });
          }
        } catch {
          // dir not created yet
        }
      }
      return out;
    },
    async read(name, archived) {
      return readTextFile(`${archived ? archive : live}/${name}`);
    },
    async write(name, text, archived = false) {
      const dir = archived ? archive : live;
      await mkdir(dir, { recursive: true });
      await writeTextFile(`${dir}/${name}`, text);
    },
    async moveToArchive(name) {
      await mkdir(archive, { recursive: true });
      await rename(`${live}/${name}`, `${archive}/${name}`);
    },
  };
}
