/** Minimal SQLite surface — implemented by tauri-plugin-sql in the app and
 * node:sqlite in tests. Keeps core DOM-free and database-vendor-agnostic. */
export type Row = Record<string, unknown>;

export interface SqliteDb {
  select<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ lastInsertId: number; changes: number }>;
}

/** Filesystem surface for snapshot files (.palimpsest/snapshots + archive).
 * Implemented by Tauri's fs plugin in the app, node:fs in tests. */
export interface SnapshotFs {
  /** Filenames of all snapshot files, live and archived. */
  list(): Promise<{ name: string; archived: boolean }[]>;
  read(name: string, archived: boolean): Promise<string>;
  /** Write a new snapshot file (atomic: temp + rename). */
  write(name: string, text: string): Promise<void>;
  /** Move a snapshot file from snapshots/ to archive/. */
  moveToArchive(name: string): Promise<void>;
}

export type SnapshotKind = 'auto' | 'system' | 'ai' | 'milestone';

export interface SnapshotMeta {
  model?: string;
  instruction?: string;
  [k: string]: unknown;
}

export interface SnapshotInfo {
  id: number;
  docId: number;
  kind: SnapshotKind;
  label: string;
  meta: SnapshotMeta;
  words: number;
  ts: number;
  archived: boolean;
  /** present on list results: relation of this snapshot's text to the current text */
  status?: SnapshotStatus;
}

export interface DocumentInfo {
  id: number;
  name: string;
  path: string | null;
  created: number;
  updated: number;
}

export type SnapshotStatus = 'current' | 'deleted' | 'modified';

export interface SearchHit {
  source: 'document' | 'history';
  docId: number;
  docName: string;
  snippet: string;
  snapshotId?: number;
  kind?: SnapshotKind;
  ts?: number;
  archived?: boolean;
  status?: SnapshotStatus;
}

export interface RecallHit {
  kind: 'document' | 'history';
  docId: number;
  docName: string;
  text: string;
  snippet: string;
  status: SnapshotStatus;
  snapshotId?: number;
  ts?: number;
}

export interface RecallResult {
  results: RecallHit[];
  tokensUsed: number;
  truncated: boolean;
}

export interface RecallOptions {
  scope?: string[] | null;
  document?: string | null;
  include?: SnapshotStatus[] | null;
}
