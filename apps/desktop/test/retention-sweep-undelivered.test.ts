/**
 * @file retention-sweep-undelivered.test.ts
 * @description ISS-6031: the 90-day retention sweep must not delete a session
 * the cloud has never received.
 *
 * This is the ROOT of the measured permanent data loss. On a clone of a real
 * 2.1 GB store, five terminal sessions whose last activity predated the
 * retention window were purged at boot — `boot: purged 5 session(s) past the
 * retention window`, in every one of the soak's clean / db-kill / app-kill
 * cycles — while they still held `pending` rows in `agent_session_sync_outbox`.
 * The sync lane then hydrated the ids it was still holding, got nothing, and
 * dead-lettered them as "locally deleted after enqueue". The dead-letter was
 * downstream; the deletion here is what destroyed the only copy.
 *
 * The guarded predicate is outbox-row EXISTENCE, not `status = 'pending'`
 * (codex review): only `clearOutboxOnAck` deletes a row, so anything still
 * there is still owed. See the first test for why `dead_lettered` in particular
 * cannot be read as "delivered".
 *
 * A focused sibling suite beside `retention-sweep-chunking.test.ts` rather than
 * another cluster in `maintenance-write-txs.test.ts` (per `test/AGENTS.md`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { sweepExpiredSessions } from "../src/main/database/session-maintenance.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { NOW, type Store, seedSession } from "./session-sweep-fixtures.js";

// The default window is 90 days, so anchor well outside it.
const EXPIRED_ACTIVITY = "2026-01-01T00:00:00.000Z";
const SOURCE_KEY = "compute-target-a";

async function seedOutboxRow(
  store: Store,
  sessionId: string,
  status: string,
  sourceKey = SOURCE_KEY
): Promise<void> {
  await store.query(
    `INSERT INTO agent_session_sync_outbox
       (source_key, external_session_id, status, sync_class, attempt_count,
        next_attempt_at, last_error, created_at, updated_at)
     VALUES ($1, $2, $3, 'backfill', 0, NULL, NULL, $4, $4)`,
    [sourceKey, sessionId, status, EXPIRED_ACTIVITY]
  );
}

async function sessionExists(store: Store, id: string): Promise<boolean> {
  const result = await store.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM sessions WHERE id = $1",
    [id]
  );
  return Number(result.rows[0]?.n ?? 0) > 0;
}

test("ISS-6031: a past-window session with an UNRESOLVED sync-outbox row is kept, not purged", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // Owed to the cloud: enqueued, never acked. Deleting it destroys the only
    // copy that exists anywhere.
    await seedSession(store, "owed", SESSION_STATUS.INACTIVE, EXPIRED_ACTIVITY);
    await seedOutboxRow(store, "owed", OutboxStatus.Pending);

    // Settled: the outbox row was CLEARED on a verified ack, so nothing is owed
    // and the governance purge is correct. `clearOutboxOnAck` is the ONLY writer
    // that removes a row, which is what makes row-existence the right predicate.
    await seedSession(
      store,
      "acked",
      SESSION_STATUS.INACTIVE,
      EXPIRED_ACTIVITY
    );

    // codex review: `dead_lettered` is NOT a delivery receipt. The lane
    // re-drives such a row from `recoverExpiredDeadLetters` (window expiry) and
    // `promoteDeadLetterIfIdle` (backfill drained), both of which flip it back
    // to `pending` via `recordOutboxReEnqueue` — and a COLD RESTART re-seeds the
    // persisted dead-letter set in `hydratePersistedCursorIfNeeded`, which is
    // what feeds the latter. Purging on `dead_lettered` therefore destroys the
    // only local copy in the window between the boot sweep and the recovery pass
    // that was about to re-send it. It must be deferred exactly like `pending`.
    await seedSession(
      store,
      "abandoned",
      SESSION_STATUS.INACTIVE,
      EXPIRED_ACTIVITY
    );
    await seedOutboxRow(store, "abandoned", OutboxStatus.DeadLettered);

    // The status column is unconstrained TEXT (see `asOutboxStatus`), so a row
    // written by a newer/older build can carry anything. An unrecognizable
    // status is an unresolved delivery, and defers for the same reason.
    await seedSession(
      store,
      "unknown-status",
      SESSION_STATUS.INACTIVE,
      EXPIRED_ACTIVITY
    );
    await seedOutboxRow(store, "unknown-status", "some_future_status");

    const { purged, deferredUndelivered } = await sweepExpiredSessions(
      prisma,
      NOW
    );

    // THE REGRESSION. Before the fix this was purged: 4 / 0. With a
    // `pending`-only predicate it is 2 / 1 — the shape codex flagged.
    assert.equal(
      purged,
      1,
      "only the acked row, which owes nothing, is purged"
    );
    assert.equal(
      deferredUndelivered,
      3,
      "every unresolved row is reported, not silently kept"
    );
    assert.equal(
      await sessionExists(store, "owed"),
      true,
      "a session the cloud has never received survives its retention window"
    );
    assert.equal(
      await sessionExists(store, "abandoned"),
      true,
      "a dead-lettered session is awaiting re-drive, not delivered — it survives too"
    );
    assert.equal(
      await sessionExists(store, "unknown-status"),
      true,
      "an unrecognized status resolves toward retention, never toward deletion"
    );
    assert.equal(await sessionExists(store, "acked"), false);
  } finally {
    await close();
  }
});

test("ISS-6031: the deferral is bounded — the same session purges once its outbox row settles", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    await seedSession(store, "owed", SESSION_STATUS.INACTIVE, EXPIRED_ACTIVITY);
    await seedOutboxRow(store, "owed", OutboxStatus.Pending);

    const first = await sweepExpiredSessions(prisma, NOW);
    assert.equal(first.purged, 0);
    assert.equal(first.deferredUndelivered, 1);

    // Delivery is acked → the lane clears the outbox row. The next boot's sweep
    // purges normally, so retention is deferred, never waived.
    await store.query(
      "DELETE FROM agent_session_sync_outbox WHERE external_session_id = $1",
      ["owed"]
    );

    const second = await sweepExpiredSessions(prisma, NOW);
    assert.equal(second.purged, 1, "the delivered session is purged as before");
    assert.equal(second.deferredUndelivered, 0);
    assert.equal(await sessionExists(store, "owed"), false);
  } finally {
    await close();
  }
});

test("ISS-6031: a pending row under ANY source key defers the purge", async () => {
  const { db: store, prisma, close } = await openTestPrisma();
  try {
    // The outbox is keyed (sourceKey, externalSessionId) and the source key
    // changes with the signed-in cloud identity. A probe scoped to one key would
    // let a purge slip through after an identity change while the row is still
    // owed under the other, so the question asked is identity-independent.
    await seedSession(
      store,
      "owed-elsewhere",
      SESSION_STATUS.INACTIVE,
      EXPIRED_ACTIVITY
    );
    await seedOutboxRow(
      store,
      "owed-elsewhere",
      OutboxStatus.Pending,
      "compute-target-b"
    );

    const { purged, deferredUndelivered } = await sweepExpiredSessions(
      prisma,
      NOW
    );
    assert.equal(purged, 0);
    assert.equal(deferredUndelivered, 1);
    assert.equal(await sessionExists(store, "owed-elsewhere"), true);
  } finally {
    await close();
  }
});
