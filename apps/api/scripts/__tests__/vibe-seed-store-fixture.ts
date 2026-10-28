/**
 * The two-session Desktop store the ISS-12017 vibe seed tests run against: the
 * perf import's snapshot fixture plus the two store columns the vibe seed reads
 * that the perf import does not (`sessions.last_activity_at`, which anchors the
 * corpus shift, and the `session_activity_metrics` rollup).
 *
 * Not a `*.test.ts`, so the runner never collects it as a suite.
 */
import type { DatabaseSync } from "node:sqlite";
import { seedRichSession, withSnapshot } from "./perf-import-snapshot-fixture";

/** The older session: one month before the newer one. */
export const OLDER_SESSION = {
  id: "older",
  startedAt: "2026-07-01T09:00:00.000Z",
  endedAt: "2026-07-01T09:30:00.000Z",
  lastActivityAt: "2026-07-01T09:30:00.000Z",
} as const;

/** The newer session; its last activity is the corpus's newest instant. */
export const NEWER_SESSION = {
  id: "newer",
  lastActivityAt: "2026-08-01T11:30:00.000Z",
} as const;

/**
 * A bookkeeping timestamp the Desktop store builder stamps with its own fixed
 * clock (`REHEARSAL_NOW_ISO`), later than any corpus instant.
 */
export const BUILDER_CLOCK_ISO = "2027-01-01T00:00:00.001Z";

export const NEWER_ACTIVITY_METRICS_ROW = {
  autonomyBand: "mixed",
  coverage: 0.5,
  spendLow: 0.1,
  spendMedium: 0.2,
  spendHigh: 0.3,
  segmentCount: 4,
  coveredSegmentCount: 2,
  version: 16,
  metricVersion: 1,
} as const;

/** Build the two-session store on disk and hand its path to `run`. */
export function withTwoSessionStore<T>(
  run: (path: string) => Promise<T> | T
): Promise<T> {
  return withSnapshot(seedTwoSessions, run);
}

function seedTwoSessions(db: DatabaseSync): void {
  db.exec("ALTER TABLE sessions ADD COLUMN last_activity_at TEXT");
  db.exec(`CREATE TABLE session_activity_metrics (
     session_id TEXT NOT NULL PRIMARY KEY, autonomy_band TEXT NOT NULL,
     coverage REAL NOT NULL DEFAULT 0,
     spend_low_conf_usd REAL NOT NULL DEFAULT 0,
     spend_medium_conf_usd REAL NOT NULL DEFAULT 0,
     spend_high_conf_usd REAL NOT NULL DEFAULT 0,
     segment_count INTEGER NOT NULL DEFAULT 0,
     covered_segment_count INTEGER NOT NULL DEFAULT 0,
     version INTEGER NOT NULL, metric_version INTEGER NOT NULL DEFAULT 1)`);
  seedRichSession(db, OLDER_SESSION.id);
  seedRichSession(db, NEWER_SESSION.id);
  db.prepare(
    `UPDATE sessions SET started_at = ?, ended_at = ?, updated_at = ?,
       last_activity_at = ? WHERE id = ?`
  ).run(
    OLDER_SESSION.startedAt,
    OLDER_SESSION.endedAt,
    BUILDER_CLOCK_ISO,
    OLDER_SESSION.lastActivityAt,
    OLDER_SESSION.id
  );
  db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").run(
    NEWER_SESSION.lastActivityAt,
    NEWER_SESSION.id
  );
  const row = NEWER_ACTIVITY_METRICS_ROW;
  db.prepare(
    `INSERT INTO session_activity_metrics (session_id, autonomy_band, coverage,
       spend_low_conf_usd, spend_medium_conf_usd, spend_high_conf_usd,
       segment_count, covered_segment_count, version, metric_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    NEWER_SESSION.id,
    row.autonomyBand,
    row.coverage,
    row.spendLow,
    row.spendMedium,
    row.spendHigh,
    row.segmentCount,
    row.coveredSegmentCount,
    row.version,
    row.metricVersion
  );
}
