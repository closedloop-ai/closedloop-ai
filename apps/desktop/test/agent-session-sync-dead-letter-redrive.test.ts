/**
 * @file agent-session-sync-dead-letter-redrive.test.ts
 * @description ISS-8271 (PLN-1839 Step 3): the session-lane boot-time targeted
 * dead-letter redrive, exercised against a real libSQL database through
 * `openSqliteAgentDatabase` (`db.syncSource`), riding the cursor load exactly as
 * production does.
 *
 * Two classes re-pend on load: `validation_failed` rows whose session row now
 * carries a real `data_revision` AND whose dead-letter is old enough to retry
 * (the pre-ISS-8271 batch-400 strandings — the reseal bumps no `updated_at`,
 * so nothing else re-sends them; the age gate keeps a fresh genuine rejection
 * from re-running its doomed send every boot, cr-72087 bhb_f0), and
 * `ack_omitted` rows behind a 1h age gate (a cloud hold that outlived its
 * budget gets a fresh retry on restart, but a rapid re-restart cannot refresh
 * a row re-dead-lettered this boot-hour — PR #6165 review) and, since
 * ISS-9182, only while the row's durable `ack_omitted_cycle_count` is under
 * the bound. A still-unsealed
 * `validation_failed` row, a too-young row of either class, any other reason
 * class, and other source keys are left alone.
 * The cursor's own `deadLetteredIds` seed is durably subtracted so the
 * re-pended rows cannot be re-seeded as set-aside on the next boot.
 *
 * Runs in the desktop `test:node` slice.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { test } from "vitest";
import { MAX_ACK_OMITTED_DEAD_LETTERS } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { AgentSessionSyncClass } from "../src/main/agent-sync/agent-session-sync-contract.js";
import { VALIDATION_FAILED_REASON } from "../src/main/agent-sync/agent-session-sync-validation-failure.js";
import { DATA_REVISION_IMPORT_PENDING } from "../src/main/collectors/engine/data-revision.js";
import { effectiveDataRevision } from "../src/main/collectors/engine/effective-data-revision.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";

const SOURCE_KEY = "agent_sessions:target-redrive";
const OTHER_KEY = "agent_sessions:target-other";

async function withDb(
  body: (
    db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>
  ) => Promise<void>
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss8271-redrive-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  try {
    const db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
      now: () => "2026-08-20T00:00:00.000Z",
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

async function insertSession(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  id: string,
  dataRevision: number
): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, data_revision)
       VALUES ($1, $1, 'inactive', '2026-08-19T00:00:00.000Z', '2026-08-19T00:10:00.000Z', 'claude', $2)`,
      id,
      dataRevision
    )
  );
}

async function deadLetter(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sourceKey: string,
  id: string,
  reason: string
): Promise<void> {
  const src = db.syncSource;
  await src.enqueueOutboxEntries?.(sourceKey, [
    { externalSessionId: id, syncClass: AgentSessionSyncClass.Backfill },
  ]);
  await src.markOutboxDeadLettered?.(sourceKey, id, reason, 3);
}

/**
 * Spend the whole durable ack-omitted allowance through the production write,
 * so the budget is charged the way a real run charges it rather than by a raw
 * UPDATE that would pass even if nothing charged it.
 */
async function spendAckOmittedBudget(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sourceKey: string,
  id: string
): Promise<void> {
  for (let cycle = 0; cycle < MAX_ACK_OMITTED_DEAD_LETTERS; cycle += 1) {
    await deadLetter(db, sourceKey, id, SyncReason.AckOmitted);
  }
}

/**
 * Age a dead-letter into the `validation_failed` redrive window — the store
 * stamps real wall-clock `updated_at` on the dead-letter, and the redrive only
 * touches `validation_failed` rows older than
 * `SESSION_VALIDATION_REDRIVE_MIN_AGE_MS` (cr-72087 bhb_f0).
 */
async function backdateDeadLetter(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sourceKey: string,
  id: string
): Promise<void> {
  await db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE agent_session_sync_outbox SET updated_at = '2026-01-01T00:00:00.000Z'
       WHERE source_key = $1 AND external_session_id = $2`,
      sourceKey,
      id
    )
  );
}

test("ISS-8271: cursor load re-pends healed validation_failed and ack_omitted dead-letters, and only those", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await insertSession(db, "healed", effectiveDataRevision());
    await insertSession(db, "unsealed", DATA_REVISION_IMPORT_PENDING);
    await insertSession(db, "held-too-new", effectiveDataRevision());
    await insertSession(db, "oversized", effectiveDataRevision());
    await insertSession(db, "fresh-reject", effectiveDataRevision());
    await insertSession(db, "fresh-hold", effectiveDataRevision());
    await insertSession(db, "other-lane", effectiveDataRevision());

    await deadLetter(db, SOURCE_KEY, "healed", VALIDATION_FAILED_REASON);
    await deadLetter(db, SOURCE_KEY, "unsealed", VALIDATION_FAILED_REASON);
    await deadLetter(db, SOURCE_KEY, "held-too-new", SyncReason.AckOmitted);
    await deadLetter(db, SOURCE_KEY, "oversized", SyncReason.LocallyOversized);
    // A young validation_failed row — a genuine (non-revision) rejection the
    // post-fix cloud just made. NOT backdated, so the age gate must skip it.
    await deadLetter(db, SOURCE_KEY, "fresh-reject", VALIDATION_FAILED_REASON);
    // An ack_omitted row that re-dead-lettered THIS boot-hour — the 1h age
    // gate must skip it so a rapid restart cannot refresh its allowance.
    await deadLetter(db, SOURCE_KEY, "fresh-hold", SyncReason.AckOmitted);
    await deadLetter(db, OTHER_KEY, "other-lane", SyncReason.AckOmitted);
    await backdateDeadLetter(db, SOURCE_KEY, "healed");
    await backdateDeadLetter(db, SOURCE_KEY, "unsealed");
    await backdateDeadLetter(db, SOURCE_KEY, "held-too-new");
    await backdateDeadLetter(db, SOURCE_KEY, "oversized");
    await backdateDeadLetter(db, OTHER_KEY, "other-lane");

    // A cursor persisted by a prior run, with every dead-letter set aside.
    assert.ok(src.advanceSyncState, "sqlite source exposes advanceSyncState");
    assert.ok(src.loadSyncState, "sqlite source exposes loadSyncState");
    await src.advanceSyncState(SOURCE_KEY, {
      observedTopUpdatedAt: "2026-08-19T00:10:00.000Z",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: [
        "healed",
        "unsealed",
        "held-too-new",
        "oversized",
        "fresh-reject",
        "fresh-hold",
      ],
    });

    const loaded = await src.loadSyncState(SOURCE_KEY);
    assert.ok(loaded, "the persisted cursor loads");
    assert.deepEqual(
      [...loaded.deadLetteredIds].sort(),
      ["fresh-hold", "fresh-reject", "oversized", "unsealed"],
      "the re-pended rows are no longer seeded as set-aside dead-letters; the unhealed, too-young, and unrelated classes still are"
    );

    const pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.ok(pending, "pending outbox ids load");
    assert.deepEqual(
      [...pending].sort(),
      ["healed", "held-too-new"],
      "exactly the aged healed validation_failed row and the aged ack_omitted row are pending again"
    );

    // The re-pend restarts the bounded retry budget from scratch. The retry
    // read deliberately filters `attempt_count > 0`, so a CORRECT re-pend
    // leaves no live budget for it to find (cr-72087 bha_p0_f0: the old loop
    // asserted over zero rows). ISS-9182: it also returns a row for its spent
    // ack-omitted cycles alone, so the two ack_omitted rows appear here —
    // carrying that cycle and nothing live.
    const retryState =
      await src.loadPendingSessionOutboxEngineState?.(SOURCE_KEY);
    assert.deepEqual(
      (retryState ?? [])
        .map((row) => ({
          id: row.id,
          attemptCount: row.attemptCount,
          permanentAttemptCount: row.permanentAttemptCount,
          nextAttemptAt: row.nextAttemptAt,
          ackOmittedCycleCount: row.ackOmittedCycleCount,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      ["fresh-hold", "held-too-new"].map((id) => ({
        id,
        attemptCount: 0,
        permanentAttemptCount: 0,
        nextAttemptAt: null,
        ackOmittedCycleCount: 1,
      })),
      "no re-pended row still carries a retry budget"
    );
    const rependedRows = await db.prisma.read((client) =>
      client.agentSessionSyncOutbox.findMany({
        where: {
          sourceKey: SOURCE_KEY,
          externalSessionId: { in: ["healed", "held-too-new"] },
        },
        orderBy: { externalSessionId: "asc" },
        select: {
          externalSessionId: true,
          status: true,
          attemptCount: true,
          lastError: true,
          nextAttemptAt: true,
          laneStalledSince: true,
        },
      })
    );
    assert.deepEqual(
      rependedRows,
      [
        {
          externalSessionId: "healed",
          status: "pending",
          attemptCount: 0,
          lastError: null,
          nextAttemptAt: null,
          laneStalledSince: null,
        },
        {
          externalSessionId: "held-too-new",
          status: "pending",
          attemptCount: 0,
          lastError: null,
          nextAttemptAt: null,
          laneStalledSince: null,
        },
      ],
      "the re-pend reset the whole durable budget, not just the status"
    );

    // Other lanes are untouched.
    const otherPending = await src.loadPendingOutboxIds?.(OTHER_KEY);
    assert.deepEqual(
      otherPending,
      [],
      "another source key's dead-letters are not re-driven by this lane's load"
    );
  });
});

test("ISS-9182: the three-cycle ack_omitted bound survives restart on the boot re-pend", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await insertSession(db, "spent", effectiveDataRevision());
    await insertSession(db, "partly-spent", effectiveDataRevision());

    await spendAckOmittedBudget(db, SOURCE_KEY, "spent");
    // One cycle short of the bound: the allowance is per ROW and this one still
    // has some, so a fixture where every row is exhausted could not tell the
    // bound from a blanket refusal.
    await deadLetter(db, SOURCE_KEY, "partly-spent", SyncReason.AckOmitted);
    for (const id of ["spent", "partly-spent"]) {
      await backdateDeadLetter(db, SOURCE_KEY, id);
    }

    assert.ok(src.advanceSyncState, "sqlite source exposes advanceSyncState");
    assert.ok(src.loadSyncState, "sqlite source exposes loadSyncState");
    await src.advanceSyncState(SOURCE_KEY, {
      observedTopUpdatedAt: "2026-08-19T00:10:00.000Z",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: ["spent", "partly-spent"],
    });
    await src.loadSyncState(SOURCE_KEY);

    const pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.ok(pending, "pending outbox ids load");
    assert.deepEqual(
      [...pending],
      ["partly-spent"],
      "the row that spent its durable allowance stays set aside; the one with allowance left re-drives"
    );

    // The counter is charged by the production dead-letter write, not by the
    // re-pend: a re-pended row keeps what it has spent, or the bound would
    // reset itself every time it let a row through.
    const counts = await db.prisma.read((client) =>
      client.agentSessionSyncOutbox.findMany({
        where: { sourceKey: SOURCE_KEY },
        orderBy: { externalSessionId: "asc" },
        select: { externalSessionId: true, ackOmittedCycleCount: true },
      })
    );
    assert.deepEqual(counts, [
      { externalSessionId: "partly-spent", ackOmittedCycleCount: 1 },
      { externalSessionId: "spent", ackOmittedCycleCount: 3 },
    ]);
  });
});

/**
 * The other doors. A recovery door flips a spent row back to `pending` with its
 * count intact, and the idle promotion re-drives a set-aside row whatever its
 * count, so the boot re-pend's filter alone left both granting a fresh three
 * cycles in the next process. The resume read is what carries the count into
 * that process, for both row states.
 */
test("ISS-9182: the resume read carries the spent ack_omitted cycles for pending and dead-lettered rows alike", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await insertSession(db, "re-pended", effectiveDataRevision());
    await insertSession(db, "set-aside", effectiveDataRevision());
    await spendAckOmittedBudget(db, SOURCE_KEY, "re-pended");
    await spendAckOmittedBudget(db, SOURCE_KEY, "set-aside");
    assert.ok(
      src.reEnqueueRecoveredDeadLetter,
      "sqlite source exposes reEnqueueRecoveredDeadLetter"
    );
    assert.equal(
      await src.reEnqueueRecoveredDeadLetter(SOURCE_KEY, "re-pended"),
      true
    );

    assert.ok(
      src.loadPendingSessionOutboxEngineState,
      "sqlite source exposes loadPendingSessionOutboxEngineState"
    );
    const rows = await src.loadPendingSessionOutboxEngineState(SOURCE_KEY);
    assert.deepEqual(
      rows
        .map((row) => ({
          id: row.id,
          status: row.status,
          ackOmittedCycleCount: row.ackOmittedCycleCount,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      [
        {
          id: "re-pended",
          status: undefined,
          ackOmittedCycleCount: MAX_ACK_OMITTED_DEAD_LETTERS,
        },
        {
          id: "set-aside",
          status: OutboxStatus.DeadLettered,
          ackOmittedCycleCount: MAX_ACK_OMITTED_DEAD_LETTERS,
        },
      ]
    );
  });
});

test("ISS-9182: a validation_failed dead-letter charges no ack_omitted cycle", async () => {
  await withDb(async (db) => {
    // The distinction the durable counter exists for: charging it on any class
    // would terminate rows that never spent an ack-omitted cycle, which is what
    // reusing `dead_letter_recovery_count` would have done.
    await insertSession(db, "rejected", effectiveDataRevision());
    await deadLetter(db, SOURCE_KEY, "rejected", VALIDATION_FAILED_REASON);
    await deadLetter(db, SOURCE_KEY, "rejected", VALIDATION_FAILED_REASON);

    const row = await db.prisma.read((client) =>
      client.agentSessionSyncOutbox.findFirst({
        where: { sourceKey: SOURCE_KEY, externalSessionId: "rejected" },
        select: { ackOmittedCycleCount: true, lastError: true },
      })
    );
    assert.deepEqual(row, {
      ackOmittedCycleCount: 0,
      lastError: VALIDATION_FAILED_REASON,
    });
  });
});

test("ISS-8271: the cursor subtraction is durable — a crash before the next persist cannot re-seed a re-driven row", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await insertSession(db, "healed", effectiveDataRevision());
    await deadLetter(db, SOURCE_KEY, "healed", VALIDATION_FAILED_REASON);
    await backdateDeadLetter(db, SOURCE_KEY, "healed");
    assert.ok(src.advanceSyncState, "sqlite source exposes advanceSyncState");
    assert.ok(src.loadSyncState, "sqlite source exposes loadSyncState");
    await src.advanceSyncState(SOURCE_KEY, {
      observedTopUpdatedAt: "2026-08-19T00:10:00.000Z",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: ["healed"],
    });

    const first = await src.loadSyncState(SOURCE_KEY);
    assert.ok(first);
    assert.deepEqual(first.deadLetteredIds, [], "re-driven on first load");

    // Second load simulates the next boot with NO advanceSyncState in between
    // (crash before any persist). The row is pending now, so the redrive matches
    // nothing — only the durable subtraction keeps the stale seed from
    // shadowing the pending row forever.
    assert.ok(src.loadSyncState, "sqlite source exposes loadSyncState");
    const second = await src.loadSyncState(SOURCE_KEY);
    assert.ok(second);
    assert.deepEqual(
      second.deadLetteredIds,
      [],
      "the stale cursor seed was durably subtracted, not just filtered in memory"
    );
    const pending = await src.loadPendingOutboxIds?.(SOURCE_KEY);
    assert.deepEqual(pending, ["healed"], "the row is still pending");
  });
});

test("ISS-11427: cursor load drops a set-aside id whose outbox row a verified ack already cleared", async () => {
  await withDb(async (db) => {
    const src = db.syncSource;
    await deadLetter(db, SOURCE_KEY, "delivered", SyncReason.LocallyOversized);
    await deadLetter(db, SOURCE_KEY, "still-out", SyncReason.LocallyOversized);
    // The incremental feed re-sent `delivered` after it changed, and the
    // verified ack deleted its row.
    await src.clearOutboxEntries?.(SOURCE_KEY, ["delivered"]);
    assert.ok(src.advanceSyncState, "sqlite source exposes advanceSyncState");
    assert.ok(src.loadSyncState, "sqlite source exposes loadSyncState");
    await src.advanceSyncState(SOURCE_KEY, {
      observedTopUpdatedAt: "2026-08-19T00:10:00.000Z",
      observedIdsAtTopUpdatedAt: [],
      deadLetteredIds: ["delivered", "still-out"],
    });

    const loaded = await src.loadSyncState(SOURCE_KEY);

    assert.deepEqual(loaded?.deadLetteredIds, ["still-out"]);
    const again = await src.loadSyncState(SOURCE_KEY);
    assert.deepEqual(
      again?.deadLetteredIds,
      ["still-out"],
      "the subtraction is durable, as the redrive's is"
    );
  });
});
