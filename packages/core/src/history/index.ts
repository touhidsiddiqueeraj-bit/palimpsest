export {
  createHistoryStore,
  type HistoryStore,
  type SnapshotWithText,
  type DocDiff,
} from './store.js';
export { SNAPSHOT_IDLE_MS, SNAPSHOT_MIN_CHURN, KEEP_NON_MILESTONE, snapshotDue } from './config.js';
export type {
  SqliteDb,
  SnapshotFs,
  SnapshotKind,
  SnapshotMeta,
  SnapshotInfo,
  SnapshotStatus,
  DocumentInfo,
  SearchHit,
  RecallHit,
  RecallResult,
  RecallOptions,
} from './types.js';
