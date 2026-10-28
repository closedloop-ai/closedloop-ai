/**
 * ISS-10721 review (tamsinb): the PRODUCER half of the activity-metrics wire
 * contract, which shipped unpinned while the cloud half was covered.
 *
 * Two of these are the single lines whose removal silently drops every rollup on
 * the floor rather than failing anything: the `syncedActivityMetricsField`
 * spread in `sync-source.ts`, and the `session_activity_metrics` entry in the
 * child-row fingerprint projections. Both are asserted at the real SQLite ->
 * payload boundary here rather than against the mapper alone, because a mapper
 * test proves what the function does with a row and nothing about whether the
 * payload assembly ever calls it.
 *
 * The third subject is the RETRACTION arm: a session whose rollup row the
 * re-tile deleted must publish an explicit `activityMetrics: null`, not an
 * omission the cloud reads as leave-it-alone.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AutonomyBand } from "@repo/api/src/types/session-activity-metrics";
import {
  MAX_ROLLUP_COUNT,
  MAX_TIER_SPEND_USD,
} from "@repo/api/src/types/session-activity-metrics-normalize";
import { test } from "vitest";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { computeSyncedChildRowFingerprint } from "../src/main/database/synced-child-row-fingerprint.js";

const SESSION_ID = "sess-iss10721";

type StoredRollup = {
  autonomyBand?: string;
  coverage?: number;
  low?: number | null;
  medium?: number | null;
  high?: number | null;
  segmentCount?: number;
  coveredSegmentCount?: number;
  version?: number;
  metricVersion?: number;
};

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

async function seedSession(db: Db) {
  await db.run(
    `INSERT INTO sessions (id, status, started_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    "inactive",
    "2026-09-20T00:00:00.000Z",
    "2026-09-20T06:00:00.000Z",
    "2026-09-20T05:00:00.000Z"
  );
}

async function seedRollup(db: Db, rollup: StoredRollup) {
  await db.run(
    `INSERT INTO session_activity_metrics
       (session_id, autonomy_band, length_band, coverage, covered_spend_usd,
        total_spend_usd, spend_low_conf_usd, spend_medium_conf_usd,
        spend_high_conf_usd, segment_count, covered_segment_count, version,
        metric_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    SESSION_ID,
    rollup.autonomyBand ?? AutonomyBand.Agentic,
    "short",
    rollup.coverage ?? 0.75,
    5.75,
    7.5,
    rollup.low ?? 1.25,
    rollup.medium ?? 2.5,
    rollup.high ?? 3.75,
    rollup.segmentCount ?? 8,
    rollup.coveredSegmentCount ?? 6,
    rollup.version ?? 4,
    rollup.metricVersion ?? 2,
    "2026-09-20T06:00:00.000Z"
  );
}

async function withDb<T>(run: (db: Db) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss10721-wiring-"));
  try {
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.pgdata"),
      detectBillingMode: () => "metered_api",
      now: () => "2026-09-20T06:00:00.000Z",
    });
    try {
      await seedSession(db);
      return await run(db);
    } finally {
      await db.close?.();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function syncedMetrics(db: Db) {
  const [session] = await db.syncSource.loadSyncedSessions(
    [SESSION_ID],
    emptyAttributionCache()
  );
  if (!session) {
    throw new Error("the session did not hydrate");
  }
  return session;
}

test("the assembled payload carries the stored rollup", async () => {
  await withDb(async (db) => {
    await seedRollup(db, {});
    const session = await syncedMetrics(db);
    assert.deepEqual(session.activityMetrics, {
      autonomyBand: AutonomyBand.Agentic,
      coverage: 0.75,
      spendLowConfUsd: 1.25,
      spendMediumConfUsd: 2.5,
      spendHighConfUsd: 3.75,
      segmentCount: 8,
      coveredSegmentCount: 6,
      classifierVersion: 4,
      metricVersion: 2,
    });
  });
});

test("a session with NO stored rollup publishes an explicit retraction", async () => {
  // Omission would read as leave-it-alone cloud-side, so a re-tile that dropped
  // the local row would leave the cloud publishing a band and a coverage for a
  // tiling that no longer exists, permanently.
  await withDb(async (db) => {
    const session = await syncedMetrics(db);
    assert.ok("activityMetrics" in session);
    assert.equal(session.activityMetrics, null);
  });
});

test("the three spend tiers are published whole or withheld whole", async () => {
  // A tier past the cloud column's Decimal(14, 6) cannot land. Publishing the
  // surviving two would not narrow the sample, it would understate the
  // attributed total and inflate every share drawn from it.
  await withDb(async (db) => {
    await seedRollup(db, { medium: MAX_TIER_SPEND_USD + 1 });
    const session = await syncedMetrics(db);
    assert.equal(session.activityMetrics?.spendLowConfUsd, undefined);
    assert.equal(session.activityMetrics?.spendMediumConfUsd, undefined);
    assert.equal(session.activityMetrics?.spendHighConfUsd, undefined);
    // The measures that are not part of the partition still publish.
    assert.equal(session.activityMetrics?.coverage, 0.75);
    assert.equal(session.activityMetrics?.segmentCount, 8);
  });
});

test("a count past the cloud int4 column is dropped, not sent", async () => {
  // SQLite stores an INTEGER up to 2^63; the destination column is int4, so
  // sending it fails the write with a 22003 that rolls the session's whole
  // transaction back and is re-poisoned on every retry.
  await withDb(async (db) => {
    await seedRollup(db, { segmentCount: MAX_ROLLUP_COUNT + 1 });
    const session = await syncedMetrics(db);
    assert.equal(session.activityMetrics?.segmentCount, undefined);
    assert.equal(session.activityMetrics?.coveredSegmentCount, 6);
  });
});

test("the child-row fingerprint moves when ONLY the rollup changes", async () => {
  // A coverage-formula bump rewrites this table and nothing else. Without the
  // `session_activity_metrics` projection entry the rebuild computes
  // `contentChanged = false`, the watermark never advances, and the corrected
  // rollup is never re-selected by the sync cursor.
  await withDb(async (db) => {
    await seedRollup(db, {});
    const before = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      false
    );
    await db.run(
      "UPDATE session_activity_metrics SET coverage = ? WHERE session_id = ?",
      0.1,
      SESSION_ID
    );
    const after = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      false
    );
    assert.notEqual(before, after);
  });
});

test("the fingerprint also moves when the rollup row is DELETED", async () => {
  // The retraction above is only reachable because the delete requeues the
  // session; a fingerprint blind to the delete would never ship the null.
  await withDb(async (db) => {
    await seedRollup(db, {});
    const before = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      false
    );
    await db.run(
      "DELETE FROM session_activity_metrics WHERE session_id = ?",
      SESSION_ID
    );
    const after = await computeSyncedChildRowFingerprint(
      db.prisma.client,
      SESSION_ID,
      false
    );
    assert.notEqual(before, after);
  });
});
