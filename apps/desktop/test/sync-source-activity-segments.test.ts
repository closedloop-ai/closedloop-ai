/**
 * FEA-3568: the sync payload assembly attaches the per-session activity-segment
 * tiling as `activitySegmentRows`, mapped to the wire shape and ordered by start,
 * and OMITS it entirely when a session has no segments (so an absent field never
 * clears cloud rows and pre-backfill history degrades to the honest fallback).
 * Drives the real SQLite -> loadSyncedSessions boundary.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_SYNCED_ACTIVITY_SEGMENTS } from "@repo/api/src/types/agent-session";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

function emptyAttributionCache() {
  return {
    attributionByCwd: new Map(),
    launchMetadataRootByCwd: new Map(),
    repoFullNameByPath: new Map(),
  };
}

test("FEA-3568: attaches activitySegmentRows (wire shape, ordered by start) for a session with segments", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3568-segments-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('seg-1','completed')"
      );
      // Insert out of start order to prove the assembly orders by start_ms.
      await db.run(
        `INSERT INTO session_activity_segments
           (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
         VALUES ('seg-b', 'seg-1', 'implement', 1000, 2000, 0.8, '["declared","structural"]', 4, 'FEA-3568', 'sub-1', 't1')`
      );
      await db.run(
        `INSERT INTO session_activity_segments
           (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
         VALUES ('seg-a', 'seg-1', 'plan', 0, 1000, 0.9, '["structural"]', 4, NULL, NULL, 't1')`
      );

      const [session] = await db.syncSource.loadSyncedSessions(
        ["seg-1"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");

      const rows = session.activitySegmentRows;
      assert.ok(rows, "activitySegmentRows emitted");
      assert.equal(rows.length, 2);
      assert.deepEqual(rows[0], {
        phase: "plan",
        startMs: 0,
        endMs: 1000,
        confidence: 0.9,
        evidenceLayers: ["structural"],
        version: 4,
        workItemRef: null,
        subagentId: null,
      });
      assert.deepEqual(rows[1], {
        phase: "implement",
        startMs: 1000,
        endMs: 2000,
        confidence: 0.8,
        evidenceLayers: ["declared", "structural"],
        version: 4,
        workItemRef: "FEA-3568",
        subagentId: "sub-1",
      });
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3568: omits activitySegmentRows for a session with no segments (honest fallback)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3568-nosegments-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('seg-empty','completed')"
      );
      const [session] = await db.syncSource.loadSyncedSessions(
        ["seg-empty"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      assert.equal(session.activitySegmentRows, undefined);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3568: bounds the segment load PER SESSION so an over-large session cannot starve a co-hydrated session", async () => {
  // Regression for the sync starvation/lockup: the tiling load must be bounded
  // per session at the DB, not globally. A single `take` on a multi-id query
  // (ordered by sessionId) would let the first, large session consume the whole
  // budget and hand the second session ZERO segments. Here `seg-aaa` sorts
  // first and is comfortably large; `seg-bbb` must still get all of its
  // segments back.
  //
  // ISS-4541: the sync-source no longer TRUNCATES an over-`MAX_SYNCED_ACTIVITY_SEGMENTS`
  // tiling — the full tiling is emitted and chunked across sync parts
  // downstream. The only remaining sync-source bound is the db-host
  // memory-safety load ceiling (far above any realistic tiling). So a session a
  // few hundred rows over the wire cap ships its tiling IN FULL and is NOT
  // flagged partial; the per-session bound only guards against one session
  // starving another at the DB read.
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3568-persession-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('seg-aaa','completed'), ('seg-bbb','completed')"
      );
      // seg-aaa: comfortably above the wire cap so a global bound would exhaust
      // on it, but well under the db-host load ceiling — its FULL tiling ships.
      const bigCount = MAX_SYNCED_ACTIVITY_SEGMENTS + 300;
      const BATCH = 200;
      for (let start = 0; start < bigCount; start += BATCH) {
        const end = Math.min(start + BATCH, bigCount);
        const values: string[] = [];
        for (let i = start; i < end; i++) {
          values.push(
            `('a-${i}', 'seg-aaa', 'other', ${i * 10}, ${i * 10 + 10}, 1, '[]', 4, NULL, NULL, 't1')`
          );
        }
        await db.run(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
           VALUES ${values.join(",")}`
        );
      }
      // seg-bbb: a small, valid tiling that must survive intact.
      await db.run(
        `INSERT INTO session_activity_segments
           (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
         VALUES
           ('b-0', 'seg-bbb', 'plan', 0, 1000, 0.9, '[]', 4, NULL, NULL, 't1'),
           ('b-1', 'seg-bbb', 'implement', 1000, 2000, 0.8, '[]', 4, NULL, NULL, 't1'),
           ('b-2', 'seg-bbb', 'review', 2000, 3000, 0.7, '[]', 4, NULL, NULL, 't1')`
      );

      const sessions = await db.syncSource.loadSyncedSessions(
        ["seg-aaa", "seg-bbb"],
        emptyAttributionCache()
      );
      const aaa = sessions.find((s) => s.externalSessionId === "seg-aaa");
      const bbb = sessions.find((s) => s.externalSessionId === "seg-bbb");
      assert.ok(aaa, "seg-aaa hydrated");
      assert.ok(bbb, "seg-bbb hydrated");
      // ISS-4541: the large session ships its FULL tiling (no sync-source
      // truncation) — the oversized tiling is chunked downstream, not dropped.
      assert.equal(
        aaa.activitySegmentRows?.length,
        bigCount,
        "the large session ships its FULL tiling (chunked downstream, not truncated here)"
      );
      assert.notEqual(
        aaa.activitySegmentRowsTruncated,
        true,
        "the sync-source no longer flags a large tiling partial (chunking replaces truncation)"
      );
      assert.equal(
        bbb.activitySegmentRows?.length,
        3,
        "the co-hydrated session keeps ALL of its segments (not starved by the large session)"
      );
      assert.notEqual(
        bbb.activitySegmentRowsTruncated,
        true,
        "the small co-hydrated session is NOT flagged partial"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4541: emits an over-wire-cap tiling IN FULL (no sync-source truncation, no partial flag)", async () => {
  // The pre-ISS-4541 sync-source truncated any tiling past the wire row/byte
  // caps and flagged it `activitySegmentRowsTruncated`. That truncation is
  // GONE: the full tiling is emitted here and chunkOversizedSession paginates
  // it across sync parts (or dead-letters the whole session against an older
  // cloud). This asserts the new contract — a tiling past the wire row cap
  // ships every row and is never flagged partial by the sync-source.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4541-full-tiling-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status) VALUES ('seg-cap','completed')"
      );
      // Comfortably above the wire row cap (MAX_SYNCED_ACTIVITY_SEGMENTS) so the
      // pre-diff behavior would have truncated it, but well under the db-host
      // load ceiling — the full tiling must ship.
      const rowCount = MAX_SYNCED_ACTIVITY_SEGMENTS + 1000;
      const BATCH = 200; // under SQLite's 500-row VALUES (compound-select) limit
      for (let start = 0; start < rowCount; start += BATCH) {
        const end = Math.min(start + BATCH, rowCount);
        const values: string[] = [];
        for (let i = start; i < end; i++) {
          values.push(
            `('seg-${i}', 'seg-cap', 'other', ${i * 10}, ${i * 10 + 10}, 1, '[]', 4, NULL, NULL, 't1')`
          );
        }
        await db.run(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
           VALUES ${values.join(",")}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["seg-cap"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      const rows = session.activitySegmentRows;
      assert.ok(rows, "activitySegmentRows emitted");
      // The FULL tiling ships — every row, past the wire row cap — because
      // oversized tilings are chunked across sync parts, not truncated here.
      assert.equal(
        rows.length,
        rowCount,
        `expected the FULL tiling; got ${rows.length} of ${rowCount}`
      );
      assert.ok(
        rows.length > MAX_SYNCED_ACTIVITY_SEGMENTS,
        "the emitted tiling is not clamped to the wire row cap (it exceeds it)"
      );
      // The sync-source no longer produces a partial cloud tiling, so the
      // partial-tiling signal is never emitted.
      assert.notEqual(session.activitySegmentRowsTruncated, true);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-4578 (wongk P1): a tiling past the db-host load ceiling is OMITTED, never shipped as a truncated prefix", async () => {
  // The per-session load is bounded at the db-host memory-safety ceiling
  // (ACTIVITY_SEGMENT_SYNC_MAX_ROWS = 50,000) + 1. When the true tiling exceeds
  // that, the loaded set is a PREFIX. Uploading it would let the cloud store a
  // partial tiling with no truncation signal and then ack + clear the outbox —
  // silent tail loss. So the sync-source OMITS `activitySegmentRows` entirely on
  // overflow (a cloud no-op that never clears the stored tiling), deferring the
  // tiling rather than shipping a lossy prefix. The rest of the session still
  // syncs.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss4578-ceiling-omit-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-10T00:00:00.000Z",
    });
    try {
      await db.run(
        "INSERT INTO sessions (id, status, name) VALUES ('seg-ceiling','completed','ceiling-session')"
      );
      // One row PAST the ceiling so the loaded prefix (ceiling + 1) proves
      // overflow. Bulk-insert in 500-row VALUES batches (SQLite compound limit).
      const rowCount = 50_000 + 1;
      const BATCH = 500;
      for (let start = 0; start < rowCount; start += BATCH) {
        const end = Math.min(start + BATCH, rowCount);
        const values: string[] = [];
        for (let i = start; i < end; i++) {
          values.push(
            `('seg-${i}', 'seg-ceiling', 'other', ${i * 10}, ${i * 10 + 10}, 1, '[]', 4, NULL, NULL, 't1')`
          );
        }
        await db.run(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
           VALUES ${values.join(",")}`
        );
      }

      const [session] = await db.syncSource.loadSyncedSessions(
        ["seg-ceiling"],
        emptyAttributionCache()
      );
      assert.ok(session, "session hydrated");
      // The tiling is OMITTED (absent), NOT a truncated prefix — an absent field
      // is the cloud's "leave the stored tiling untouched" no-op.
      assert.equal(
        session.activitySegmentRows,
        undefined,
        "an over-ceiling tiling must be omitted, never shipped as a partial prefix"
      );
      // Never flagged partial (the partial signal is gone) and the rest of the
      // session still synced (name present).
      assert.notEqual(session.activitySegmentRowsTruncated, true);
      assert.equal(session.name, "ceiling-session");
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
