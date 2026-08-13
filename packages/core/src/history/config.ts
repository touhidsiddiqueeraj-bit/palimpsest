/** Snapshot policy constants (spec §4.3). */
export const SNAPSHOT_IDLE_MS = 25_000;
export const SNAPSHOT_MIN_CHURN = 120;
export const KEEP_NON_MILESTONE = 300;

/** True when an auto snapshot is due: enough idle time and enough churn. */
export function snapshotDue(nowMs: number, lastSnapMs: number, churnChars: number): boolean {
  return nowMs - lastSnapMs >= SNAPSHOT_IDLE_MS && churnChars >= SNAPSHOT_MIN_CHURN;
}
