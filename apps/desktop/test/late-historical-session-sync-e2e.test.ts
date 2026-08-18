/**
 * @file late-historical-session-sync-e2e.test.ts
 * @description ISS-5086 delivery coverage: a substantive historical session
 * imported AFTER the durable sync cursor has advanced past its activity time
 * must still reach the cloud — durably outboxed, uploaded, acked, and cleared —
 * and a restart must not force a full re-walk.
 *
 * This closes the seam the existing ISS-5086 suites leave open. They cover the
 * two halves separately: `historical-import-sync-watermark.test.ts` asserts the
 * `sessions.updated_at` stamp against the real store but never runs the sync
 * service, and `agent-session-sync-service.test.ts` runs the real service but
 * against `FakeSyncSource`, whose in-memory list has no cursor/keyset scan to
 * skip a row. Neither can fail if discovery drops a below-watermark session, so
 * this drives the REAL sqlite source through the REAL service and asserts on
 * delivery rather than on the timestamp.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSessionSyncTransportPayload } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import {
  makeServiceWithIdentity,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const COMPUTE_TARGET = "compute-target-iss5086";
const SOURCE_KEY = buildAgentSessionSyncSourceKey(COMPUTE_TARGET);

/** Wall clock when the RECENT session is imported — this advances the cursor. */
const IMPORT_RECENT_AT = "2026-08-04T00:20:00.000Z";
/** Wall clock when the HISTORICAL transcript is discovered — strictly later. */
const IMPORT_HISTORICAL_AT = "2026-08-04T00:43:06.000Z";

/**
 * The reported production row (`e639495e-…`): activity entirely BELOW the
 * watermark the recent session set. Its `ended_at` predates the recent
 * session's import, so a scan keyed on activity time can never reach it.
 */
const HISTORICAL_STARTED_AT = "2026-08-03T22:09:18.626Z";
const HISTORICAL_ENDED_AT = "2026-08-03T23:08:37.780Z";
const RECENT_STARTED_AT = "2026-08-04T00:10:00.000Z";
const RECENT_ENDED_AT = "2026-08-04T00:19:00.000Z";

const RECENT_ID = "recent-session-advances-cursor";
const HISTORICAL_ID = "late-historical-below-cursor";

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

/** Ids the transport was asked to upload, flattened across batches. */
function uploadedIds(batches: AgentSessionSyncTransportPayload[]): string[] {
  return batches.flatMap((batch) =>
    batch.sessions.map((session) => session.externalSessionId)
  );
}

/**
 * Drive the real service until its session lane reports caught-up, then wait on
 * the durable write queue so every acked outbox delete has actually committed.
 *
 * Both waits are REAL completion signals, never an event-loop-turn budget
 * (FEA-2399 determinism / ISS-4807 / PR #4392 review, wongk):
 *
 * - `settleSelfContinuedDrain` pumps the TIMERS phase the self-continue
 *   reschedule actually lives in (`SyncPollTimers.scheduleDrain` →
 *   `setTimeout(…, 0)`) and gates on `getSyncProgress().caughtUp`, THROWING if
 *   the lane never settles. A fixed count of `flushAgentSessionSync` yields only
 *   the check phase, so on a loaded runner it can return before the pass has
 *   uploaded anything and leave the assertions reading a pre-upload snapshot.
 * - Goal stage 2 made `clearOutboxOnAck` awaited inside ack processing, so a
 *   settled lane now implies the ack delete committed — but `writeQueue.drain()`
 *   is kept as the explicit barrier before reading durable outbox state, both
 *   as belt-and-braces and because the OTHER outbox writers (enqueue,
 *   dead-letter, retry) remain fire-and-forget.
 *
 * `stop()` runs in `finally` so a thrown assertion cannot strand the poll timer.
 */
async function drainSync(
  db: Db,
  sent: AgentSessionSyncTransportPayload[]
): Promise<void> {
  const service = makeServiceWithIdentity(
    db.syncSource,
    (batch) => {
      sent.push(batch);
      return Promise.resolve({ accepted: true as const });
    },
    COMPUTE_TARGET
  );
  service.start();
  try {
    await settleSelfContinuedDrain(service);
  } finally {
    service.stop();
  }
  await db.writeQueue.drain();
}

async function pendingOutboxIds(db: Db): Promise<string[]> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { external_session_id: string }[]
  >(
    "SELECT external_session_id FROM agent_session_sync_outbox WHERE source_key = ? AND status = ? ORDER BY external_session_id",
    SOURCE_KEY,
    OutboxStatus.Pending
  );
  return rows.map((row) => row.external_session_id);
}

test("ISS-5086: a late historical session below the cursor is uploaded, acked, and cleared from the outbox", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "late-historical-sync-"));
  let clock = IMPORT_RECENT_AT;
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "metered_api",
    now: () => clock,
  });

  try {
    // 1. A recent session is imported and synced, advancing the durable cursor
    //    past the historical session's activity window.
    const recent = await db.importer.importSession(
      makePopulatedSession({
        sessionId: RECENT_ID,
        startedAt: RECENT_STARTED_AT,
        endedAt: RECENT_ENDED_AT,
      }),
      "claude"
    );
    assert.notEqual(recent.failed, true, "recent session must import");

    const firstPass: AgentSessionSyncTransportPayload[] = [];
    await drainSync(db, firstPass);
    assert.ok(
      uploadedIds(firstPass).includes(RECENT_ID),
      "the recent session must upload first so the cursor genuinely advances"
    );
    assert.deepEqual(
      await pendingOutboxIds(db),
      [],
      "an accepted ack must clear the recent session's outbox row"
    );

    // 2. NOW the historical transcript is discovered — later wall clock, older
    //    activity. Pre-fix this row was stamped with its old ended_at and fell
    //    below the cursor forever.
    clock = IMPORT_HISTORICAL_AT;
    const historical = await db.importer.importSession(
      makePopulatedSession({
        sessionId: HISTORICAL_ID,
        startedAt: HISTORICAL_STARTED_AT,
        endedAt: HISTORICAL_ENDED_AT,
      }),
      "claude"
    );
    assert.notEqual(historical.failed, true, "historical session must import");

    // 3. Drive the SAME store's sync again with no cursor reset and no restart.
    const secondPass: AgentSessionSyncTransportPayload[] = [];
    await drainSync(db, secondPass);

    // 4. Delivery, not just visibility.
    assert.ok(
      uploadedIds(secondPass).includes(HISTORICAL_ID),
      `the late historical session must be uploaded; got ${JSON.stringify(uploadedIds(secondPass))}`
    );
    assert.deepEqual(
      await pendingOutboxIds(db),
      [],
      "the acked historical session must leave no pending outbox row"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-5086: a restart after the repair re-walks nothing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "late-historical-restart-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  let clock = IMPORT_RECENT_AT;

  try {
    const first = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => clock,
    });
    const sentBeforeRestart: AgentSessionSyncTransportPayload[] = [];
    try {
      await first.importer.importSession(
        makePopulatedSession({
          sessionId: RECENT_ID,
          startedAt: RECENT_STARTED_AT,
          endedAt: RECENT_ENDED_AT,
        }),
        "claude"
      );
      clock = IMPORT_HISTORICAL_AT;
      await first.importer.importSession(
        makePopulatedSession({
          sessionId: HISTORICAL_ID,
          startedAt: HISTORICAL_STARTED_AT,
          endedAt: HISTORICAL_ENDED_AT,
        }),
        "claude"
      );
      await drainSync(first, sentBeforeRestart);
      assert.ok(
        uploadedIds(sentBeforeRestart).includes(HISTORICAL_ID),
        "both sessions must be delivered before the restart"
      );
    } finally {
      await first.close();
    }

    // Reopen the SAME store — the durable cursor carries the current integrity
    // version, so the one-time repair walk must not repeat.
    const second = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => clock,
    });
    try {
      const afterRestart: AgentSessionSyncTransportPayload[] = [];
      await drainSync(second, afterRestart);
      assert.deepEqual(
        uploadedIds(afterRestart),
        [],
        `a restart on a drained, current-version cursor must re-upload nothing; got ${JSON.stringify(uploadedIds(afterRestart))}`
      );
    } finally {
      await second.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
