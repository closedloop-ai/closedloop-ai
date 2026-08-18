/**
 * FEA-3473 (PRD-536): contract test for the durable per-session metadata-sync
 * OUTBOX store, exercised against a real libSQL database through
 * `openSqliteAgentDatabase` + `createSqliteSessionSyncSource` (`db.syncSource`).
 * Proves the enqueue/clear/mark/loadPending round trip that the sync service's
 * crash-correct resume depends on, and that the 0025 migration applies. Runs in
 * the desktop `test:node` slice.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";

const SOURCE_KEY = "agent_sessions:target-outbox";
const OTHER_KEY = "agent_sessions:target-other";

async function withDb(
  body: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fea3473-outbox-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-07-18T00:00:00.000Z",
    });
    try {
      await body(db);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("FEA-3473: outbox enqueue → loadPending → clear-on-ack round trip", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.enqueueOutboxEntries,
      "sqlite source exposes enqueueOutboxEntries"
    );
    assert.ok(
      src.clearOutboxEntries,
      "sqlite source exposes clearOutboxEntries"
    );
    assert.ok(
      src.loadPendingOutboxIds,
      "sqlite source exposes loadPendingOutboxIds"
    );

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "s1", syncClass: "backfill" },
      { externalSessionId: "s2", syncClass: "backfill" },
      { externalSessionId: "s3", syncClass: "incremental" },
    ]);

    let pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.deepEqual(
      [...(pending ?? [])].sort(),
      ["s1", "s2", "s3"],
      "all enqueued ids are pending"
    );

    // Verified-ack clear removes only the acked ids (per-item durable progress).
    await src.clearOutboxEntries?.(SOURCE_KEY, ["s1", "s3"]);
    pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.deepEqual(
      [...(pending ?? [])],
      ["s2"],
      "acked ids are cleared; only un-acked survive"
    );
  });
});

test("FEA-3473: mark dead-lettered records the reason and drops the id from pending", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "ghost", syncClass: "backfill" },
    ]);
    await src.markOutboxDeadLettered?.(SOURCE_KEY, "ghost", "unhydratable");

    const pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.deepEqual(
      [...(pending ?? [])],
      [],
      "a dead-lettered id is no longer pending (never re-enqueued on resume)"
    );
  });
});

test("FEA-3659: a transient retry stamps attempt_count + next_attempt_at (stays pending); dead-letter records the exhausted count", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(src.recordOutboxRetry, "sqlite source exposes recordOutboxRetry");

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "retryme", syncClass: "backfill" },
    ]);

    // Two transient retries with growing backoff: the row stays pending and the
    // durable attempt_count / next_attempt_at reflect the in-memory budget.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "retryme",
      1,
      "2026-07-18T00:05:00.000Z",
      "ingestion_failed"
    );
    let row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "retryme",
        },
      },
    });
    assert.equal(row?.status, "pending", "a transient retry stays pending");
    assert.equal(row?.attemptCount, 1, "attempt_count is stamped");
    assert.equal(row?.nextAttemptAt, "2026-07-18T00:05:00.000Z");
    assert.equal(row?.lastError, "ingestion_failed");
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      ["retryme"],
      "a retrying row is still pending (re-enqueued on resume)"
    );

    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "retryme",
      4,
      "2026-07-18T00:20:00.000Z",
      "ingestion_failed"
    );

    // Budget exhausted → dead-letter records the REAL attempt_count, not 0, and
    // clears next_attempt_at (no longer awaiting a scheduled retry).
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "retryme",
      "ingestion_failed",
      5
    );
    row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "retryme",
        },
      },
    });
    assert.equal(row?.status, "dead_lettered");
    assert.equal(
      row?.attemptCount,
      5,
      "dead-letter records the exhausted attempt_count, not a misleading 0"
    );
    assert.equal(
      row?.nextAttemptAt,
      null,
      "a dead-lettered row clears next_attempt_at"
    );
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      [],
      "a dead-lettered id is no longer pending"
    );
  });
});

test("FEA-3659: recordOutboxRetry leaves a dead_lettered row dead_lettered (never resurrects it) while still stamping the retry columns", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(src.recordOutboxRetry, "sqlite source exposes recordOutboxRetry");

    // A transient row that exhausted its budget and dead-lettered.
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "dead-row", syncClass: "backfill" },
    ]);
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "dead-row",
      "ingestion_failed",
      5
    );

    // Real-source hardening: recordOutboxRetry's update branch leaves `status`
    // UNTOUCHED, so even if it were ever invoked on a dead_lettered row (it is
    // not in today's flow — dead-lettered ids are excluded from the retry
    // queues), the row must NOT be silently resurrected to pending. The retry
    // columns are still updated, proving the guard is on `status` alone.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "dead-row",
      6,
      "2026-07-21T00:05:00.000Z",
      "rate_limited"
    );
    const row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "dead-row",
        },
      },
    });
    assert.equal(
      row?.status,
      "dead_lettered",
      "a retry write must NOT resurrect a dead_lettered row (status untouched)"
    );
    assert.equal(
      row?.attemptCount,
      6,
      "attempt_count is still updated by the retry write"
    );
    assert.equal(
      row?.nextAttemptAt,
      "2026-07-21T00:05:00.000Z",
      "next_attempt_at is still updated by the retry write"
    );
    assert.equal(
      row?.lastError,
      "rate_limited",
      "last_error is still updated by the retry write"
    );
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      [],
      "the dead_lettered row is never re-enqueued as pending"
    );
  });
});

test("FEA-3659: loadPendingOutboxRetryState returns the durable retry budget for mid-backoff rows only", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.loadPendingOutboxRetryState,
      "sqlite source exposes loadPendingOutboxRetryState"
    );

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "fresh", syncClass: "backfill" },
      { externalSessionId: "backing-off", syncClass: "backfill" },
      { externalSessionId: "dead", syncClass: "backfill" },
    ]);
    // One row is mid-backoff, one is dead-lettered, one is a fresh pending row.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "backing-off",
      4,
      "2026-07-18T00:20:00.000Z",
      "ingestion_failed"
    );
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "dead",
      "ingestion_failed",
      5
    );

    const retryState = await src.loadPendingOutboxRetryState?.(SOURCE_KEY);
    assert.deepEqual(
      retryState,
      [
        {
          id: "backing-off",
          attemptCount: 4,
          nextAttemptAt: "2026-07-18T00:20:00.000Z",
          lastError: "ingestion_failed",
        },
      ],
      "only still-pending rows with a recorded attempt_count are returned (fresh + dead-lettered excluded)"
    );
  });
});

test("FEA-3473: re-enqueue never resurrects a dead-lettered row as pending", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "d1", syncClass: "backfill" },
    ]);
    await src.markOutboxDeadLettered?.(SOURCE_KEY, "d1", "validation_failed");
    // A later enqueue of the same id must NOT flip it back to pending.
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "d1", syncClass: "incremental" },
    ]);
    const pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.deepEqual(
      [...(pending ?? [])],
      [],
      "a re-enqueued dead-lettered id stays dead-lettered"
    );
  });
});

test("FEA-3697: a recovered dead-letter is durably re-pended so it survives a restart and resumes exactly once", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.reEnqueueRecoveredDeadLetter,
      "sqlite source exposes reEnqueueRecoveredDeadLetter"
    );

    // A transient rejection burned its retry budget and dead-lettered with a
    // recorded attempt_count / next_attempt_at (the FEA-3363 finite-deadline
    // case). This is the durable state a running desktop holds while the
    // retry-after window ticks down.
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "recover-me", syncClass: "backfill" },
    ]);
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "recover-me",
      3,
      "2026-07-18T00:15:00.000Z",
      "ingestion_failed"
    );
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "recover-me",
      "ingestion_failed",
      5
    );
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      [],
      "before recovery the dead-lettered row is not pending"
    );

    // The retry-after deadline elapses → recoverExpiredDeadLetters recovers the
    // id. Before FEA-3697 this only mutated in-memory state, leaving the durable
    // row dead_lettered; a restart here would strand the session. Now it durably
    // flips the row back to pending.
    await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "recover-me");

    // SIMULATED RESTART: a fresh process re-reads the outbox. loadPendingOutboxIds
    // is the resume path, so the recovered row must resurface as pending — proof
    // the recovery survived the crash rather than being lost with in-memory state.
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      ["recover-me"],
      "a recovered dead-letter is durably pending again (re-discovered on restart)"
    );

    // The recovered row restarts the bounded retry budget from scratch (mirrors
    // the in-memory clearFailureStateForId): attempt_count reset, deadline/error
    // cleared, status pending. It therefore follows the normal retry/dead-letter
    // policy on the next attempt rather than dead-lettering instantly.
    const row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "recover-me",
        },
      },
    });
    assert.equal(row?.status, "pending", "recovered row is pending");
    assert.equal(row?.attemptCount, 0, "recovered row resets its retry budget");
    assert.equal(row?.nextAttemptAt, null, "recovered row clears its deadline");
    assert.equal(row?.lastError, null, "recovered row clears its last error");

    // A mid-backoff row is not returned as retry-state after recovery (its budget
    // was reset), so a resume does not re-arm a stale deferral for it.
    assert.deepEqual(
      await src.loadPendingOutboxRetryState?.(SOURCE_KEY),
      [],
      "recovery resets the durable retry budget (nothing to rehydrate)"
    );

    // EXACTLY-ONCE: the recovered row re-syncs, the server acks it, and the
    // verified-ack clear is the ONLY durable delete. After the ack the row is
    // gone, so a further restart cannot re-send it (no double-processing) and it
    // was never dropped while un-acked (no strand).
    await src.clearOutboxEntries?.(SOURCE_KEY, ["recover-me"]);
    assert.deepEqual(
      await src.loadPendingOutboxIds?.(SOURCE_KEY),
      [],
      "an acked recovered row is cleared exactly once — never re-sent on restart"
    );
  });
});

test("FEA-3697: re-enqueue only flips a dead_lettered row (never resets an in-flight pending retry, no-op on absent)", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;

    // A still-pending row mid-backoff: recovery must NOT touch it (that would
    // reset an in-flight retry's budget out from under it).
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "in-flight", syncClass: "backfill" },
    ]);
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "in-flight",
      2,
      "2026-07-18T00:10:00.000Z",
      "ingestion_failed"
    );
    await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "in-flight");
    const pendingRow = await db.prisma.client.agentSessionSyncOutbox.findUnique(
      {
        where: {
          sourceKey_externalSessionId: {
            sourceKey: SOURCE_KEY,
            externalSessionId: "in-flight",
          },
        },
      }
    );
    assert.equal(
      pendingRow?.attemptCount,
      2,
      "an already-pending row keeps its in-flight retry budget"
    );
    assert.equal(
      pendingRow?.nextAttemptAt,
      "2026-07-18T00:10:00.000Z",
      "an already-pending row keeps its scheduled deadline"
    );

    // An absent row (already cleared by a verified ack) is a silent no-op, not a
    // throw or a resurrected phantom pending row.
    await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "never-existed");
    assert.deepEqual(
      [...((await src.loadPendingOutboxIds?.(SOURCE_KEY)) ?? [])].sort(),
      ["in-flight"],
      "recovering an absent id creates no phantom pending row"
    );
  });
});

test("FEA-3473: the outbox is scoped per source key (one account never sees another's rows)", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "mine", syncClass: "backfill" },
    ]);
    await src.enqueueOutboxEntries?.(OTHER_KEY, [
      { externalSessionId: "theirs", syncClass: "backfill" },
    ]);
    assert.deepEqual(
      [...((await src.loadPendingOutboxIds?.(SOURCE_KEY)) ?? [])],
      ["mine"],
      "only this source key's pending ids are returned"
    );
    assert.deepEqual(
      [...((await src.loadPendingOutboxIds?.(OTHER_KEY)) ?? [])],
      ["theirs"],
      "the other source key's rows are isolated"
    );
  });
});

test("ISS-4447: a corpus-scale enqueue spanning multiple chunks lands every id pending, and a dead-lettered id inside a large batch is not resurrected", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    // OUTBOX_ENQUEUE_CHUNK_SIZE is 200; 450 crosses three chunks so the batched
    // multi-row INSERT ... ON CONFLICT path (not just the single-chunk fast
    // path) is exercised end to end.
    const total = 450;
    const ids = Array.from({ length: total }, (_, i) => `bulk-${i}`);
    // Dead-letter one id BEFORE the bulk enqueue so its ON CONFLICT branch runs
    // inside a multi-row statement — proving the batched update never touches
    // `status` at scale, exactly as the single-id path guarantees.
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "bulk-7", syncClass: "backfill" },
    ]);
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "bulk-7",
      "validation_failed"
    );
    await src.enqueueOutboxEntries?.(
      SOURCE_KEY,
      ids.map((externalSessionId) => ({
        externalSessionId,
        syncClass: "backfill" as const,
      }))
    );
    const pending = new Set(
      (await src.loadPendingOutboxIds?.(SOURCE_KEY)) ?? []
    );
    // Every id except the dead-lettered one is pending.
    assert.equal(
      pending.size,
      total - 1,
      "all bulk ids except the dead-lettered one are pending"
    );
    assert.ok(
      !pending.has("bulk-7"),
      "the dead-lettered id is not resurrected by a large batched re-enqueue"
    );
    // Spot-check the last id in the final chunk actually persisted.
    assert.ok(pending.has(`bulk-${total - 1}`), "the final-chunk id persisted");
  });
});

test("ISS-4710 (@wongk, real store path): loadReadyInvocationSyncParts resolves on the reader pool while a writer transaction is held", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.loadReadyInvocationSyncParts,
      "sqlite source exposes loadReadyInvocationSyncParts"
    );

    // Model a first-boot DATA_REVISION rebuild: a real writer `$transaction`
    // parked open on a deferred, so the single writer connection is occupied for
    // the whole window. If the ready-parts probe ran on `prisma.client` (the
    // writer connection) it would serialize BEHIND this held transaction and
    // never resolve until it releases — the exact stall this PR fixes. Routed
    // through `prisma.read`, it hits a `query_only` reader on a committed WAL
    // snapshot concurrently, so it resolves while the writer is still held.
    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    // Signal from INSIDE the transaction so the read only runs once the writer is
    // provably open and parked (not merely before the write's own microtasks ran).
    let signalWriterHeld!: () => void;
    const writerHeld = new Promise<void>((resolve) => {
      signalWriterHeld = resolve;
    });
    let writeSettled = false;
    const busyWrite = db.prisma.write((client) =>
      client.$transaction(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1");
        signalWriterHeld();
        try {
          await writeHeld;
        } finally {
          writeSettled = true;
        }
      })
    );
    busyWrite.catch(() => undefined);

    try {
      await writerHeld;
      // No ready parts materialized — an empty resolve is enough to prove the
      // probe did NOT block on the held writer connection.
      const parts = await src.loadReadyInvocationSyncParts?.(
        SOURCE_KEY,
        "2026-07-18T00:00:00.000Z",
        10
      );
      assert.equal(
        writeSettled,
        false,
        "loadReadyInvocationSyncParts returned while the writer transaction was still held"
      );
      assert.deepEqual(
        parts,
        [],
        "the reader-pool probe resolved (no ready parts)"
      );
    } finally {
      releaseWrite();
      await busyWrite;
    }
  });
});
