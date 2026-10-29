/**
 * @file sync-source-paged-tiling-composed.test.ts
 * @description ISS-9865 (davetho P2, PR #7099) — a >50,000-segment tiling read
 * from REAL SQLite reaches the cloud, in full and exactly once, across the
 * accepted POSTs of the REAL sync lane.
 *
 * Everything else that covers this ticket stops at one seam. The SQLite suite
 * (`sync-source-activity-segments.test.ts`) proves the paged read returns the
 * whole tiling and goes no further; the payload suites call
 * `prepareAgentSessionPayload` / `chunkOversizedSession` on a hand-built
 * session and never touch SQLite. Between those two halves sits the wiring —
 * the outbox, the chunk sequencing, the ack — and a cursor-tail or sequencing
 * failure there leaves every one of those suites green while no row is ever
 * delivered. This file is the join: real store in, real POSTs out.
 *
 * It asserts the union of every accepted POST, keyed by `startMs`, rather than a
 * per-chunk shape. A chunker that shipped the same page twice, or dropped the
 * tail, satisfies a count-of-chunks assertion and fails this one.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import type { ActivitySegmentReadBounds } from "../src/main/database/sync-source-bounded-reads.js";
import { ACTIVITY_SEGMENT_SYNC_MAX_ROWS } from "../src/main/database/sync-source-bounded-reads.js";
import { settleSelfContinuedDrain } from "./agent-session-sync-service-fixtures.js";

const SESSION_ID = "paged-tiling-composed";
const COMPUTE_TARGET_ID = "compute-target-iss9865-composed";
/** One row past the paging threshold: the smallest tiling that must be paged. */
const SEGMENT_COUNT = ACTIVITY_SEGMENT_SYNC_MAX_ROWS + 1;
/** SQLite's compound-SELECT limit caps a single multi-row VALUES insert. */
const SEED_BATCH = 500;

test("ISS-9865: a >50K SQLite tiling reaches the accepted POSTs whole and exactly once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss9865-composed-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-09-11T00:00:00.000Z",
    });
    try {
      await db.run(
        `INSERT INTO sessions (id, status, name, updated_at)
         VALUES ('${SESSION_ID}','completed','paged tiling','2026-09-11T00:00:00.000Z')`
      );
      // One real tool use, so the lane judges the session SUBSTANTIVE
      // (`syncedSessionIsSubstantive`) and uploads it. Without it the session is
      // an idle phantom, withheld before any tiling is ever chunked — and the
      // whole assertion below would pass vacuously on an empty POST list.
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, summary, data, created_at)
         VALUES ('${SESSION_ID}-evt', '${SESSION_ID}', 'PostToolUse', 'Bash', 'ran', '{}', '2026-09-11T00:00:00.000Z')`
      );
      for (let start = 0; start < SEGMENT_COUNT; start += SEED_BATCH) {
        const end = Math.min(start + SEED_BATCH, SEGMENT_COUNT);
        const values: string[] = [];
        for (let i = start; i < end; i++) {
          values.push(
            `('seg-${i}', '${SESSION_ID}', 'other', ${i * 10}, ${i * 10 + 10}, 1, '[]', 4, NULL, NULL, 't1')`
          );
        }
        await db.run(
          `INSERT INTO session_activity_segments
             (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
           VALUES ${values.join(",")}`
        );
      }

      const posted: AgentSessionSyncTransportPayload[] = [];
      const service = new AgentSessionSyncService({
        isHttpReady: () => true,
        getSource: () => db.syncSource,
        getSyncComputeTargetId: () => COMPUTE_TARGET_ID,
        // The capable server: the tiling paginates into its own chunks rather
        // than riding the base, which is the path a paged read produces.
        isSyncActivityChunkingSupported: () => true,
        sendBatch: (batch) => {
          posted.push(batch);
          return Promise.resolve({ accepted: true as const });
        },
      });
      service.start();
      try {
        await settleSelfContinuedDrain(service);
      } finally {
        service.stop();
      }

      // The union across every accepted POST, keyed by the receiver's own
      // idempotency key. A duplicated page shows up as a repeated key, a lost
      // tail as a missing one — neither is visible in a total row count alone.
      const deliveredStartMs: number[] = [];
      for (const batch of posted) {
        for (const session of batch.sessions) {
          if (session.externalSessionId !== SESSION_ID) {
            continue;
          }
          for (const row of session.activitySegmentRows ?? []) {
            deliveredStartMs.push(row.startMs);
          }
        }
      }

      assert.equal(
        new Set(deliveredStartMs).size,
        SEGMENT_COUNT,
        `every one of the ${SEGMENT_COUNT} segments must reach an accepted POST`
      );
      assert.equal(
        deliveredStartMs.length,
        SEGMENT_COUNT,
        "and exactly once — a repeated page would make this exceed the set size"
      );
      // The lane really did have to SPLIT this: a single POST carrying the whole
      // tiling would mean the wire cap was never reached and the assertions
      // above prove nothing about the paged path.
      assert.ok(
        posted.length > 1,
        `the tiling must cross as multiple parts; got ${posted.length} POST(s)`
      );
      // No part may claim the tiling was stripped: this one is deliverable.
      for (const batch of posted) {
        for (const session of batch.sessions) {
          assert.notEqual(
            session.activitySegmentRowsStripped,
            true,
            "a tiling the lane actually delivered must not be marked stripped"
          );
        }
      }
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * ISS-9865 (davetho P1, PR #7099): a tiling the read REFUSES at the absolute
 * ceiling ships as a STRIPPED, OWED delivery — never acknowledged as a complete
 * sync.
 *
 * This is the failure the refusal path exists to prevent, and it is invisible
 * from every other angle: the session syncs, the server accepts it, the outbox
 * clears, and nothing anywhere records that a tiling was ever owed. Driven at a
 * seeded ceiling through the factory's `activitySegmentReadBounds` — see that
 * parameter for why the seam is at the factory — because the production number
 * is half a million rows.
 */
const SEEDED_BOUNDS: ActivitySegmentReadBounds = {
  pagingThreshold: 4,
  pageSize: 3,
  absoluteCeiling: 9,
};
const REFUSED_SESSION = "paged-tiling-refused";

test("ISS-9865: a tiling PAST the ceiling ships stripped and OWED, not as a complete sync", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss9865-refused-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-09-11T00:00:00.000Z",
    });
    try {
      await db.run(
        `INSERT INTO sessions (id, status, name, updated_at)
         VALUES ('${REFUSED_SESSION}','completed','refused tiling','2026-09-11T00:00:00.000Z')`
      );
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, summary, data, created_at)
         VALUES ('${REFUSED_SESSION}-evt', '${REFUSED_SESSION}', 'PostToolUse', 'Bash', 'ran', '{}', '2026-09-11T00:00:00.000Z')`
      );
      const refusedCount = SEEDED_BOUNDS.absoluteCeiling + 1;
      const values: string[] = [];
      for (let i = 0; i < refusedCount; i++) {
        values.push(
          `('rseg-${i}', '${REFUSED_SESSION}', 'other', ${i * 10}, ${i * 10 + 10}, 1, '[]', 4, NULL, NULL, 't1')`
        );
      }
      await db.run(
        `INSERT INTO session_activity_segments
           (id, session_id, phase, start_ms, end_ms, confidence, evidence_layers, version, work_item_ref, subagent_id, observed_at)
         VALUES ${values.join(",")}`
      );

      const posted: AgentSessionSyncTransportPayload[] = [];
      const source = createSqliteSessionSyncSource(
        db.prisma,
        () => {
          // the diagnostic sink is not what this test asserts
        },
        SEEDED_BOUNDS
      );
      const service = new AgentSessionSyncService({
        isHttpReady: () => true,
        getSource: () => source,
        getSyncComputeTargetId: () => COMPUTE_TARGET_ID,
        isSyncActivityChunkingSupported: () => true,
        sendBatch: (batch) => {
          posted.push(batch);
          return Promise.resolve({ accepted: true as const });
        },
      });
      service.start();
      try {
        await settleSelfContinuedDrain(service);
      } finally {
        service.stop();
      }

      const delivered = posted.flatMap((batch) =>
        batch.sessions.filter(
          (session) => session.externalSessionId === REFUSED_SESSION
        )
      );
      assert.ok(
        delivered.length > 0,
        "the REST of the session must still sync — a refused tiling is not a refused session"
      );
      // THE POSITIVE. Without the stamp this payload is byte-identical to a
      // session that simply has no tiling, so the ack settles it as complete and
      // the outbox clears with the tiling permanently gone and unrecorded.
      for (const session of delivered) {
        assert.equal(
          session.activitySegmentRowsStripped,
          true,
          "every part of a refused delivery must declare the strip"
        );
        assert.equal(
          session.activitySegmentRows,
          undefined,
          "a refused tiling ships no rows at all — not a prefix, not an empty array"
        );
      }
      // THE DEBT. The ack turns the declared strip into the ISS-7265 durable
      // repair row; a delivery that settled instead would leave this empty.
      const owed = await db.prisma.read((reader) =>
        reader.$queryRawUnsafe<{ session_id: string }[]>(
          "SELECT session_id FROM activity_tiling_repair_owed"
        )
      );
      assert.deepEqual(
        owed.map((row) => row.session_id),
        [REFUSED_SESSION],
        "the refused tiling is recorded OWED, not acknowledged as delivered"
      );
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
