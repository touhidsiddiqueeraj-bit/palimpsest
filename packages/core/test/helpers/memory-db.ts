import { DatabaseSync } from 'node:sqlite';
import type { Row, SqliteDb } from '../../src/history/types.js';

/** node:sqlite implementation of SqliteDb for unit tests (zero native deps). */
export function memoryDb(): SqliteDb {
  const db = new DatabaseSync(':memory:');
  return {
    async select<T = Row>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const info = db.prepare(sql).run(...(params as never[]));
      return { lastInsertId: Number(info.lastInsertRowid), changes: Number(info.changes) };
    },
  };
}
