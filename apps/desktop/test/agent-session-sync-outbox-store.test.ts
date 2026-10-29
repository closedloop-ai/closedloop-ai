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
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { test } from "vitest";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { sqliteReEnqueueRecoveredDeadLetter } from "../src/main/database/sync-outbox-store.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";

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
      { externalSessionId: "s1", syncClass: AgentSessionSyncMode.Backfill },
      { externalSessionId: "s2", syncClass: AgentSessionSyncMode.Backfill },
      {
        externalSessionId: "s3",
        syncClass: AgentSessionSyncMode.Incremental,
      },
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

test("ISS-8617: loadPendingOutboxIds restores future backoff rows so the engine can defer them", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "fresh", syncClass: AgentSessionSyncMode.Backfill },
      { externalSessionId: "due", syncClass: AgentSessionSyncMode.Backfill },
      {
        externalSessionId: "waiting",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);

    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "due",
      1,
      "2026-07-18T00:05:00.000Z",
      SyncReason.IngestionFailed,
      null
    );
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "waiting",
      1,
      "9999-01-01T00:00:00.000Z",
      SyncReason.IngestionFailed,
      null
    );

    assert.deepEqual(
      [...((await src.loadPendingOutboxIds?.(SOURCE_KEY)) ?? [])].sort(),
      ["due", "fresh", "waiting"],
      "future backoff rows stay queued; ready selection happens after engine-state hydration"
    );
  });
});

test("FEA-3473: mark dead-lettered records the reason and drops the id from pending", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "ghost", syncClass: AgentSessionSyncMode.Backfill },
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
      {
        externalSessionId: "retryme",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);

    // Two transient retries with growing backoff: the row stays pending and the
    // durable attempt_count / next_attempt_at reflect the in-memory budget.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "retryme",
      1,
      "2026-07-18T00:05:00.000Z",
      SyncReason.IngestionFailed,
      null
    );
    let row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "retryme",
        },
      },
    });
    assert.equal(
      row?.status,
      OutboxStatus.Pending,
      "a transient retry stays pending"
    );
    assert.equal(row?.attemptCount, 1, "attempt_count is stamped");
    assert.equal(row?.nextAttemptAt, "2026-07-18T00:05:00.000Z");
    assert.equal(row?.lastError, SyncReason.IngestionFailed);
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
      SyncReason.IngestionFailed,
      null
    );

    // Budget exhausted → dead-letter records the REAL attempt_count, not 0, and
    // clears next_attempt_at (no longer awaiting a scheduled retry).
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "retryme",
      SyncReason.IngestionFailed,
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
    assert.equal(row?.status, OutboxStatus.DeadLettered);
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
      {
        externalSessionId: "dead-row",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "dead-row",
      SyncReason.IngestionFailed,
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
      "rate_limited",
      null
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
      OutboxStatus.DeadLettered,
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

test("ISS-8617: loadPendingSessionOutboxEngineState returns live retry rows plus dead-letter recovery state", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.loadPendingSessionOutboxEngineState,
      "sqlite source exposes loadPendingSessionOutboxEngineState"
    );

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "fresh", syncClass: AgentSessionSyncMode.Backfill },
      {
        externalSessionId: "backing-off",
        syncClass: AgentSessionSyncMode.Backfill,
      },
      { externalSessionId: "dead", syncClass: AgentSessionSyncMode.Backfill },
    ]);
    // One row is mid-backoff, one is dead-lettered, one is a fresh pending row.
    // ISS-7730: the mid-backoff row is also mid-OUTAGE, so it carries a durable
    // lane-stall clock — the read must hand it back or a relaunch restarts the
    // only bound a lane-wide failure has.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "backing-off",
      4,
      "2026-07-18T00:20:00.000Z",
      SyncReason.IngestionFailed,
      "2026-07-17T23:00:00.000Z"
    );
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "dead",
      SyncReason.IngestionFailed,
      5,
      5,
      2
    );

    const retryState =
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY);
    assert.deepEqual(
      [...(retryState ?? [])].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
      [
        {
          id: "backing-off",
          attemptCount: 4,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 0,
          ackOmittedCycleCount: 0,
          nextAttemptAt: "2026-07-18T00:20:00.000Z",
          lastError: SyncReason.IngestionFailed,
          laneStalledSince: "2026-07-17T23:00:00.000Z",
        },
        {
          id: "dead",
          status: OutboxStatus.DeadLettered,
          attemptCount: 0,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 2,
          ackOmittedCycleCount: 0,
          nextAttemptAt: null,
          lastError: null,
          laneStalledSince: null,
        },
      ],
      "pending rows restore live retry state; dead-lettered rows restore only recovery state"
    );
  });
});

test("FEA-3473: re-enqueue never resurrects a dead-lettered row as pending", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "d1", syncClass: AgentSessionSyncMode.Backfill },
    ]);
    await src.markOutboxDeadLettered?.(SOURCE_KEY, "d1", "validation_failed");
    // A later enqueue of the same id must NOT flip it back to pending.
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      { externalSessionId: "d1", syncClass: AgentSessionSyncMode.Incremental },
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
      {
        externalSessionId: "recover-me",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "recover-me",
      3,
      "2026-07-18T00:15:00.000Z",
      SyncReason.IngestionFailed,
      null
    );
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "recover-me",
      SyncReason.IngestionFailed,
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
    assert.equal(
      await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "recover-me"),
      true,
      "ISS-7216: the flip reports the confirmation enforceDeadLetterCap releases on"
    );

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
    assert.equal(row?.status, OutboxStatus.Pending, "recovered row is pending");
    assert.equal(row?.attemptCount, 0, "recovered row resets its retry budget");
    assert.equal(row?.nextAttemptAt, null, "recovered row clears its deadline");
    assert.equal(row?.lastError, null, "recovered row clears its last error");

    // A mid-backoff row is not returned as retry-state after recovery (its budget
    // was reset), so a resume does not re-arm a stale deferral for it.
    assert.deepEqual(
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY),
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
      {
        externalSessionId: "in-flight",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "in-flight",
      2,
      "2026-07-18T00:10:00.000Z",
      SyncReason.IngestionFailed,
      null
    );
    assert.equal(
      await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "in-flight"),
      true,
      "ISS-7216: a zero-row no-op over an already-pending row is CONFIRMED, not a failure — the row is discoverable, so nothing is owed to the dead-letter set"
    );
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
    assert.equal(
      await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "never-existed"),
      true,
      "ISS-7216: an absent row is CONFIRMED too — the ack already discharged it, so the cap may release the id"
    );
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
      { externalSessionId: "mine", syncClass: AgentSessionSyncMode.Backfill },
    ]);
    await src.enqueueOutboxEntries?.(OTHER_KEY, [
      { externalSessionId: "theirs", syncClass: AgentSessionSyncMode.Backfill },
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
      { externalSessionId: "bulk-7", syncClass: AgentSessionSyncMode.Backfill },
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
        syncClass: AgentSessionSyncMode.Backfill,
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

test("ISS-4710 (@whitlockk, real store path): loadReadyInvocationSyncParts resolves on the reader pool while a writer transaction is held", async () => {
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

test("ISS-7730: clearOutboxLaneStall ends the stall run on pending rows only, and touches nothing else", async () => {
  // The durable half of "a row-attributable rejection proves the lane
  // answered". Driven against the REAL sqlite store, because the acceptance
  // suite reaches this contract only through `FakeSyncSource` — a `where` scope
  // that drifted to include dead-lettered rows, or a delegate never wired to the
  // db-host, would ship green off the fake alone.
  await withDb(async (db) => {
    const src = db.syncSource;
    assert.ok(
      src.clearOutboxLaneStall,
      "sqlite source exposes clearOutboxLaneStall"
    );

    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      {
        externalSessionId: "stalled-pending",
        syncClass: AgentSessionSyncMode.Backfill,
      },
      {
        externalSessionId: "stalled-dead",
        syncClass: AgentSessionSyncMode.Backfill,
      },
      {
        externalSessionId: "other-lane",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    const STALL = "2026-07-17T23:00:00.000Z";
    for (const id of ["stalled-pending", "stalled-dead", "other-lane"]) {
      await src.recordOutboxRetry?.(
        SOURCE_KEY,
        id,
        3,
        "2026-07-18T00:05:00.000Z",
        SyncReason.IngestionFailed,
        STALL
      );
    }
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "stalled-dead",
      "ingestion_failed_lane_stalled",
      3
    );

    await src.clearOutboxLaneStall?.(SOURCE_KEY, [
      "stalled-pending",
      "stalled-dead",
    ]);

    const rowFor = (id: string) =>
      db.prisma.client.agentSessionSyncOutbox.findUnique({
        where: {
          sourceKey_externalSessionId: {
            sourceKey: SOURCE_KEY,
            externalSessionId: id,
          },
        },
      });

    const pending = await rowFor("stalled-pending");
    assert.equal(pending?.laneStalledSince, null, "the pending row's run ends");
    assert.equal(
      pending?.status,
      OutboxStatus.Pending,
      "the clear must not move the row's status"
    );
    assert.equal(
      pending?.attemptCount,
      3,
      "the clear touches only the stall clock — the attempt tally is evidence"
    );
    assert.equal(pending?.nextAttemptAt, "2026-07-18T00:05:00.000Z");
    assert.equal(pending?.lastError, SyncReason.IngestionFailed);

    const dead = await rowFor("stalled-dead");
    assert.equal(
      dead?.laneStalledSince,
      STALL,
      "a dead-lettered row KEEPS its stamp — it is the evidence of why it was abandoned"
    );

    const untouched = await rowFor("other-lane");
    assert.equal(
      untouched?.laneStalledSince,
      STALL,
      "a row the caller did not name is not cleared"
    );
  });
});

test("ISS-7730: re-pending a recovered dead-letter restarts its stall clock from scratch", async () => {
  // A recovered row must not inherit an already-expired run: if it did, its very
  // first post-recovery 5xx would cross the ceiling and abandon it again. The
  // existing FEA-3697 recovery test seeds no stall stamp, so this is the only
  // case where the `laneStalledSince: null` in the re-pend write can fail.
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      {
        externalSessionId: "recovered",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "recovered",
      4,
      "2026-07-18T00:05:00.000Z",
      SyncReason.IngestionFailed,
      "2026-07-17T00:00:00.000Z"
    );
    await src.markOutboxDeadLettered?.(
      SOURCE_KEY,
      "recovered",
      "ingestion_failed_lane_stalled",
      4
    );

    await src.reEnqueueRecoveredDeadLetter?.(SOURCE_KEY, "recovered");

    const row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "recovered",
        },
      },
    });
    assert.equal(row?.status, OutboxStatus.Pending);
    assert.equal(
      row?.laneStalledSince,
      null,
      "the recovered row starts a fresh run, not the expired one it was abandoned on"
    );
    assert.equal(row?.attemptCount, 0, "and a fresh budget, as before");
  });
});

test("ISS-7216: a re-pend that matches ZERO ROWS is confirmed by reading the row back, not assumed", async () => {
  // The mode a try/catch cannot see. `sqliteReEnqueueRecoveredDeadLetter` is an
  // `updateMany` guarded on `status = dead_lettered`, so a write that changes
  // nothing resolves normally — and `enforceDeadLetterCap` deletes the only
  // in-memory reference to the id on the strength of that resolution. A `0`
  // therefore has to be RESOLVED rather than assumed: it means the row is
  // pending/withheld/absent (nothing owed, safe to release) or that the flip
  // did not take and the row is still `dead_lettered` (the session would be
  // lost). The real DB can only produce the safe readings — a `dead_lettered`
  // row that the guard skipped is by construction unreachable through SQL — so
  // the unsafe one is driven through a stub handle, which is also the only way
  // to prove the readback is load-bearing rather than decorative.
  assert.equal(
    await sqliteReEnqueueRecoveredDeadLetter(
      stubPrismaForRePend({
        updatedCount: 0,
        statusAfter: OutboxStatus.DeadLettered,
      }),
      SOURCE_KEY,
      "still-dead"
    ),
    false,
    "zero rows AND the row still dead_lettered is a FAILED hand-off — the cap must keep the id"
  );
  assert.equal(
    await sqliteReEnqueueRecoveredDeadLetter(
      stubPrismaForRePend({ updatedCount: 0, statusAfter: null }),
      SOURCE_KEY,
      "gone"
    ),
    true,
    "zero rows over an absent row is confirmed — nothing is owed"
  );
  assert.equal(
    await sqliteReEnqueueRecoveredDeadLetter(
      stubPrismaForRePend({
        updatedCount: 0,
        statusAfter: OutboxStatus.Pending,
      }),
      SOURCE_KEY,
      "already-pending"
    ),
    true,
    "zero rows over an already-pending row is confirmed — the outbox already carries it"
  );
  assert.equal(
    await sqliteReEnqueueRecoveredDeadLetter(
      stubPrismaForRePend({
        updatedCount: 1,
        statusAfter: OutboxStatus.DeadLettered,
      }),
      SOURCE_KEY,
      "flipped"
    ),
    true,
    "a row the update actually flipped is confirmed without a readback (the stale status here would fail the test if one were taken)"
  );
});

/**
 * A `DesktopPrisma` stand-in that reports exactly the `updateMany` count and
 * post-write row state a case needs. Only the two members
 * `sqliteReEnqueueRecoveredDeadLetter` touches are modelled.
 */
function stubPrismaForRePend(outcome: {
  updatedCount: number;
  statusAfter: OutboxStatus | null;
}): DesktopPrisma {
  const client = {
    agentSessionSyncOutbox: {
      updateMany: () => Promise.resolve({ count: outcome.updatedCount }),
      findUnique: () =>
        Promise.resolve(
          outcome.statusAfter === null ? null : { status: outcome.statusAfter }
        ),
    },
  };
  return {
    client,
    write: <T>(fn: (c: typeof client) => Promise<T>) => fn(client),
  } as unknown as DesktopPrisma;
}

test("ISS-7730: recordOutboxRetry with a null laneStalledSince CLEARS a stamp already on the row", async () => {
  // The write `ack_omitted` relies on to end a stale run. It is the ONE class
  // that reaches the durable clear through the bounded fold's own outbox write
  // rather than through `clearOutboxLaneStall`, and the fold-level test can only
  // prove the fold passed `null` to its collaborator — a store whose update
  // branch omitted the column, or spread it before `outboxRetryFields` and let a
  // same-named field win, would satisfy that and still leave the stamp on disk.
  // A relaunch then rehydrates the stale run and the row is abandoned as
  // lane-stalled on its next 5xx, on a demonstrably healthy lane.
  await withDb(async (db) => {
    const src = db.syncSource;
    await src.enqueueOutboxEntries?.(SOURCE_KEY, [
      {
        externalSessionId: "answered",
        syncClass: AgentSessionSyncMode.Backfill,
      },
    ]);
    // A lane-wide outage stamped the run.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "answered",
      2,
      "2026-07-18T00:05:00.000Z",
      SyncReason.IngestionFailed,
      "2026-07-17T23:00:00.000Z"
    );
    const stalled = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "answered",
        },
      },
    });
    assert.equal(
      stalled?.laneStalledSince,
      "2026-07-17T23:00:00.000Z",
      "precondition: the row really is mid-run before the clearing write"
    );

    // The server then answered ABOUT THE ROW, so the run is over.
    await src.recordOutboxRetry?.(
      SOURCE_KEY,
      "answered",
      3,
      "2026-07-18T00:10:00.000Z",
      "ack_omitted",
      null
    );

    const row = await db.prisma.client.agentSessionSyncOutbox.findUnique({
      where: {
        sourceKey_externalSessionId: {
          sourceKey: SOURCE_KEY,
          externalSessionId: "answered",
        },
      },
    });
    assert.equal(
      row?.laneStalledSince,
      null,
      "the null actually reached the column — the run is over on disk, not just in memory"
    );
    assert.equal(
      row?.status,
      OutboxStatus.Pending,
      "and the row is still pending"
    );
    assert.equal(
      row?.attemptCount,
      3,
      "the retry columns the same write carries still land"
    );
    assert.equal(row?.lastError, "ack_omitted");
    assert.equal(row?.nextAttemptAt, "2026-07-18T00:10:00.000Z");
  });
});
