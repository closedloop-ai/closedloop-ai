/**
 * @file sync-outbox-store.ts
 * @description The per-session sync OUTBOX (`agent_session_sync_outbox`): what
 * still owes delivery to the cloud, and the durable retry/dead-letter budget
 * attached to each row. Sibling of `sync-cursor-state.ts` (the keyset cursor
 * over `sync_state`); together they are the delivery-state half that FEA-3781
 * split out of `sync-source.ts`, which is about BUILDING sync payloads.
 *
 * One table, one module. Every function takes the `DesktopPrisma` handle
 * explicitly rather than closing over it, matching the sibling read modules
 * (`aggregateSqliteAnalytics`, `countSqliteSessionsForFilters`, …).
 * `sync-source.ts` delegates its `AgentSessionSyncSource` methods here
 * one-for-one, so the source's public shape is unchanged.
 *
 * Writes route through `prisma.write` so they serialize on the single-connection
 * write queue; reads use `prisma.client` (light, co-located with writes).
 */

import { SyncReason } from "@closedloop-ai/telemetry-contract/sync";
import { MIN_REAL_DATA_REVISION } from "../../shared/data-revision-contract.js";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import { MAX_ACK_OMITTED_DEAD_LETTERS } from "../agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionOutboxEntry,
  SessionOutboxEngineState,
} from "../agent-sync/agent-session-sync-source.js";
import { VALIDATION_FAILED_REASON } from "../agent-sync/agent-session-sync-validation-failure.js";
import type { OutboxClearResult } from "../agent-sync/outbox-clear-result.js";
import {
  outboxRePendFields,
  outboxWithheldFields,
  sessionOutboxDeadLetterFields,
  sessionOutboxRetryFields,
} from "../sync/durable-outbox.js";
import type { DesktopPrisma } from "./prisma-client.js";
import { WriteQueueClass } from "./write-queue.js";

/**
 * FEA-3473: append `pending` outbox rows for newly-enqueued session ids.
 * Upsert keyed by (sourceKey, externalSessionId): a re-enqueue of an id
 * already present is a no-op on `create` and, on `update`, leaves an existing
 * row's status untouched (never resets a dead_lettered row back to pending —
 * only the `sync_class` / `updated_at` are refreshed). Routed through
 * `prisma.write` so it serializes on the single-connection write queue.
 */
export async function sqliteEnqueueOutboxEntries(
  prisma: DesktopPrisma,
  sourceKey: string,
  entries: AgentSessionOutboxEntry[]
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  // ISS-4447: batch the enqueue as chunked multi-row
  // `INSERT … ON CONFLICT DO UPDATE` statements instead of awaiting one
  // typed `upsert` per id inside the serialized writer callback. A per-id
  // await serializes N round-trips through the write queue; on a large
  // candidate set (or the initial full-corpus backfill seed) that
  // monopolizes startup writer time. One statement per chunk collapses that
  // to ⌈N / OUTBOX_ENQUEUE_CHUNK_SIZE⌉ writes. The ON CONFLICT clause
  // preserves the exact prior semantics: refresh `sync_class`/`updated_at`
  // but NEVER touch `status`, so a re-enqueue of a `dead_lettered` id does
  // not silently resurrect it as `pending`.
  // ISS-4710: the enqueue seeds/refreshes the full backfill candidate set (the
  // whole-corpus seed on a DATA_REVISION heal), so it is a `bulk` writer. Tagging
  // it `bulk` lets the interactive transcript/component hot-path writes interleave
  // instead of queueing behind this batched write during a rebuild.
  //
  // ISS-4710 (@chatgpt-codex): submit each chunk as its OWN bulk task rather than
  // looping every chunk inside one task. The scheduler only switches classes
  // BETWEEN tasks, so a single task spanning all ⌈N/OUTBOX_ENQUEUE_CHUNK_SIZE⌉
  // statements would still make an interactive write that arrives mid-loop wait
  // for the entire full-corpus seed — the class tag alone would not yield the
  // claimed interleaving on large histories. One bulk task per chunk gives the
  // weighted round-robin a real task boundary to serve interactive writes at.
  // Each chunk's `$executeRawUnsafe` is an independent idempotent
  // `INSERT … ON CONFLICT` (no cross-chunk transaction), so splitting the loop
  // into separate tasks preserves the prior semantics exactly.
  for (const chunkEntries of chunkOutboxEntries(
    entries,
    OUTBOX_ENQUEUE_CHUNK_SIZE
  )) {
    await prisma.write(
      (client) =>
        client.$executeRawUnsafe(
          buildOutboxUpsertSql(chunkEntries.length),
          ...buildOutboxUpsertParams(sourceKey, now, chunkEntries)
        ),
      undefined,
      { class: WriteQueueClass.Bulk }
    );
  }
}

/**
 * FEA-3473: delete the outbox rows for `ids` under `sourceKey`. Called ONLY
 * after a VERIFIED server ack (per-item durable progress).
 *
 * ISS-7957: reports `deleteMany`'s own `count` — the rows this statement
 * actually removed, which is NOT the number of ids it was asked about. An ack
 * naming an id whose row is already gone contributes nothing to the count, and
 * that divergence is the whole point: `durablyClearedRows` used to be populated
 * from the ack length and therefore reported progress that had not happened.
 * The count is triage evidence plus one constrained stall-detector input (ISS-10429);
 * `outbox-clear-result.ts` says which.
 */
export async function sqliteClearOutboxEntries(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: string[]
): Promise<OutboxClearResult> {
  if (ids.length === 0) {
    // Nothing was asked for, so nothing was removed. A MEASURED zero: this
    // statement ran (vacuously) and its answer is known.
    return { deletedRowCount: 0 };
  }
  // ISS-4710: verified-ack clears fire in bulk as a large backfill drains, so tag
  // them `bulk` for the same writer-fairness reason as the enqueue above.
  const deleted = await prisma.write(
    (client) =>
      client.agentSessionSyncOutbox.deleteMany({
        where: { sourceKey, externalSessionId: { in: ids } },
      }),
    undefined,
    { class: WriteQueueClass.Bulk }
  );
  return { deletedRowCount: deleted.count };
}

/**
 * FEA-3659: durably record a transient outbox retry with backoff — stamp the
 * incremented `attempt_count`, the `next_attempt_at` deadline, and the
 * `last_error` class, WITHOUT flipping the row to `dead_lettered`. This is the
 * persisted twin of the in-memory per-session retry budget: a transient
 * rejection defers here with a growing `attempt_count`, so the durable outbox
 * reflects that the row is mid-backoff instead of misreporting
 * `attempt_count=0`. ISS-8605 widened the caller set: EVERY environmental defer
 * calls this — `ingestion_failed`, `rate_limited`, `ack_timeout`, and an ack
 * reason the build cannot name — plus the `ack_omitted` defer. (Before that,
 * `rate_limited` deferred with an in-memory-only budget and `ack_timeout` wrote
 * nothing here at all, so a 408 left no durable trace between attempts.)
 *
 * ISS-7730: `lane_stalled_since` rides the same write. For an ENVIRONMENTAL
 * class it carries the start of the row's unbroken lane-wide run, which is what
 * makes the wall-clock bound survive a relaunch; every row-attributable caller
 * passes null and that null CLEARS the column, because an answered rejection
 * proves the lane is reachable. Note the split with `attempt_count`: for the
 * lane-wide class the count is a tally kept as evidence and read by the failure
 * diagnostic, and no terminal path consults it — the clock is the bound, which
 * is why the environmental caller AWAITS this write while the row-attributable
 * ones do not (`agent-session-outbox-writers.ts`).
 * Upsert keeps it
 * robust to a missing row (an id enqueued before the outbox shipped) without
 * throwing; a genuinely-absent row is created as `pending` so it is still
 * eligible for re-send.
 *
 * FEA-3659: the `update` branch leaves `status` UNTOUCHED so a retry write can
 * never resurrect a `dead_lettered` row. `recordOutboxRetry` is only invoked on
 * the still-pending defer path (a transient rejection whose retry budget is not
 * yet exhausted), and dead-lettered ids are excluded from the retry queues, so
 * the update always lands on a `pending` row, and leaving `status` alone keeps
 * it `pending`. Were it ever to land on a `dead_lettered` row, NOT touching
 * `status` avoids the durable-outbox inconsistency where `loadPendingOutboxIds`
 * never re-enqueues the row. `loadPendingSessionOutboxEngineState` now blanks
 * live retry fields for dead-lettered rows too, preserving that same boundary.
 * This mirrors the `FakeSyncSource.recordOutboxRetry` test fake, which likewise
 * preserves the existing status.
 */
export async function sqliteRecordOutboxRetry(
  prisma: DesktopPrisma,
  sourceKey: string,
  id: string,
  attemptCount: number,
  nextAttemptAt: string,
  reason: string,
  laneStalledSince: string | null,
  permanentAttemptCount?: number | null
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.upsert({
      where: {
        sourceKey_externalSessionId: {
          sourceKey,
          externalSessionId: id,
        },
      },
      create: {
        sourceKey,
        externalSessionId: id,
        status: OutboxStatus.Pending,
        // The row is genuinely absent (the normal path records a retry on an
        // existing pending row; create only fires for an id enqueued before
        // the outbox shipped), so its original class is unknown here — the
        // caller iterates outbox ids in bulk and does not carry a per-id
        // syncClass. `backfill` is the safe default: it matches the schema
        // default and the dead-letter create-branch precedent below, and the
        // field is diagnostic-only (it does not affect send/retry behavior).
        syncClass: "backfill",
        attemptCount,
        permanentAttemptCount: permanentAttemptCount ?? 0,
        deadLetterRecoveryCount: 0,
        nextAttemptAt,
        lastError: reason,
        laneStalledSince,
        pendingSince: now,
        createdAt: now,
        updatedAt: now,
      },
      // FEA-3659: the update branch leaves `status` untouched so a retry write
      // can never resurrect a dead_lettered row; recordOutboxRetry is only
      // invoked on still-pending rows, and dead-lettered ids are excluded from
      // the retry queues. PLN-1562: `outboxRetryFields` omits `status` for
      // exactly that reason, so the invariant is now carried by the shared
      // builder rather than by remembering not to add the column here.
      update: {
        ...sessionOutboxRetryFields({
          attemptCount,
          permanentAttemptCount,
          nextAttemptAt,
          reason,
          nowIso: now,
          laneStalledSince,
        }),
      },
      select: OUTBOX_ROW_SELECT,
    })
  );
}

/**
 * FEA-3473: mark an outbox row `dead_lettered` with a recorded `reason`. The
 * row must already exist (it was enqueued as pending); an upsert keeps this
 * robust to a missing row (e.g. a dead-letter of an id enqueued before this
 * feature shipped) without throwing.
 *
 * FEA-3659: stamp the real `attempt_count` (the exhausted retry budget) rather
 * than a misleading 0, and clear `next_attempt_at` (the row is no longer
 * pending a scheduled retry). Deterministic classes that dead-letter at their
 * first failure pass `attemptCount: 0` and are unaffected.
 *
 * ISS-9182: an `ack_omitted` dead-letter also charges the DURABLE cycle budget,
 * `ack_omitted_cycle_count`. The class test lives here, at the one write that
 * records a dead-letter reason for this lane. The increment is relative rather
 * than a write of the in-memory `ackOmittedCycleById`, which only counts the
 * RECOVERABLE cycles of this process; the column also counts the terminal
 * one, so it can run ahead of the map and never behind it. A resume seeds the
 * map from it ({@link sqliteLoadPendingSessionOutboxEngineState}), and
 * {@link sqliteSelectRedrivableSessionDeadLetters} bounds the boot re-pend on
 * it.
 */
export async function sqliteMarkOutboxDeadLettered(
  prisma: DesktopPrisma,
  sourceKey: string,
  id: string,
  reason: string,
  attemptCount = 0,
  permanentAttemptCount: number | null = null,
  deadLetterRecoveryCount: number | null = null
): Promise<void> {
  const now = new Date().toISOString();
  const chargesAckOmittedCycle = reason === SyncReason.AckOmitted;
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.upsert({
      where: {
        sourceKey_externalSessionId: {
          sourceKey,
          externalSessionId: id,
        },
      },
      create: {
        sourceKey,
        externalSessionId: id,
        status: OutboxStatus.DeadLettered,
        syncClass: "backfill",
        attemptCount,
        permanentAttemptCount: permanentAttemptCount ?? 0,
        deadLetterRecoveryCount: deadLetterRecoveryCount ?? 0,
        ackOmittedCycleCount: chargesAckOmittedCycle ? 1 : 0,
        nextAttemptAt: null,
        lastError: reason,
        createdAt: now,
        updatedAt: now,
      },
      // PLN-1562: the shared dead-letter field shape, carrying the real burned
      // attempt count (FEA-3659) rather than a misleading 0.
      update: {
        ...sessionOutboxDeadLetterFields({
          reason,
          attemptCount,
          permanentAttemptCount,
          deadLetterRecoveryCount,
          nowIso: now,
        }),
        ...(chargesAckOmittedCycle
          ? { ackOmittedCycleCount: { increment: 1 } }
          : {}),
      },
      select: OUTBOX_ROW_SELECT,
    })
  );
}

/**
 * FEA-3697: durably flip a RECOVERED dead-letter's row back to `pending` so a
 * restart re-discovers it via `loadPendingOutboxIds`. The recovery paths
 * (`recoverExpiredDeadLetters`, `promoteDeadLetterIfIdle`) re-queue the id in
 * memory; without this durable flip the row stays `dead_lettered` on disk and
 * the recovered session is silently stranded after the next restart.
 *
 * The `WHERE status = dead_lettered` guard makes this a targeted, atomic
 * transition: it ONLY resurrects a `dead_lettered` row (a genuinely-recovered
 * one) and never disturbs a `pending` row — so it cannot reset the retry
 * budget of an in-flight retry out from under it, and it is a no-op on an
 * absent row (already cleared by a verified ack). `updateMany` (not `update`)
 * so a missing/already-pending row is a 0-row no-op rather than a throw.
 * Resets `attempt_count` and clears `next_attempt_at` / `last_error` so the
 * recovered row restarts the bounded retry/dead-letter budget from scratch,
 * mirroring the in-memory `clearFailureStateForId`. Exactly-once is preserved:
 * `clearOutboxEntries` (verified-ack delete) stays the only clear, and the
 * server dedupes an already-applied payload, so re-pending never
 * double-applies or drops a row. Routed through `prisma.write` so it
 * serializes on the single-connection write queue.
 *
 * ISS-7216: reports whether the row is CONFIRMED off `dead_lettered` afterwards.
 * `enforceDeadLetterCap` is the one caller that drops its only in-memory
 * reference to the id, so for it a swallowed failure is a lost session; a
 * boolean the caller can gate the release on is what makes that hand-off safe.
 * A zero-row update is deliberately NOT reported as failure on its own — the
 * `dead_lettered` guard also matches nothing when the row is already `pending`
 * (an in-flight retry), `withheld`, or gone (cleared by a verified ack), and in
 * each of those the outbox already owes what it should. Only a row still
 * sitting `dead_lettered` after the write means the flip did not take, so that
 * is the single `false`. A thrown write never reaches the check and surfaces as
 * a rejection for the caller to fold.
 */
export async function sqliteReEnqueueRecoveredDeadLetter(
  prisma: DesktopPrisma,
  sourceKey: string,
  id: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const updated = await prisma.write((client) =>
    client.agentSessionSyncOutbox.updateMany({
      where: {
        sourceKey,
        externalSessionId: id,
        status: OutboxStatus.DeadLettered,
      },
      // PLN-1562: the shared re-pend field shape — back to `pending` with the
      // live retry budget restarted from scratch. ISS-7730: the lane-stall clock
      // restarts with it, or a recovered row would inherit an already-expired run
      // and be abandoned again on its first 5xx. The durable recovery ladder stays
      // until a verified ack clears the row.
      data: {
        ...outboxRePendFields(now),
        pendingSince: now,
        laneStalledSince: null,
        permanentAttemptCount: 0,
      },
    })
  );
  if (updated.count > 0) {
    return true;
  }
  const row = await prisma.client.agentSessionSyncOutbox.findUnique({
    where: {
      sourceKey_externalSessionId: { sourceKey, externalSessionId: id },
    },
    select: { status: true },
  });
  return row?.status !== OutboxStatus.DeadLettered;
}

/**
 * FEA-3473: the still-`pending` session ids for `sourceKey`, oldest first, so
 * a restart re-enqueues exactly the enqueued-but-not-acked sessions. A read
 * failure surfaces as a throw to the caller, which logs and continues (the
 * full-backfill walk remains the safety net).
 */
export async function sqliteLoadPendingOutboxIds(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<string[]> {
  const rows = await prisma.client.agentSessionSyncOutbox.findMany({
    where: { sourceKey, status: OutboxStatus.Pending },
    select: { externalSessionId: true },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => row.externalSessionId);
}

/**
 * FEA-3659 / ISS-8617: the persisted engine state for session outbox rows that
 * have live retry/stall state or a durable recovery ladder to seed on resume.
 * Pending rows restore the retry budget, deferred-retry deadline, and stall
 * clock. Dead-lettered rows restore only the recovery count; their live retry
 * fields are intentionally blanked so a set-aside id cannot be selected through
 * the normal ready path before its recovery door re-pends it.
 *
 * ISS-9182: both kinds also restore `ack_omitted_cycle_count`, and a row that
 * carries nothing else is selected for it alone. A recovery door flips a row
 * that has spent its cycles back to `pending` with the count intact, and the
 * idle promotion re-drives a set-aside one regardless of the count, so without
 * this the next process granted either a fresh three.
 */
export async function sqliteLoadPendingSessionOutboxEngineState(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<SessionOutboxEngineState[]> {
  const rows = await prisma.client.agentSessionSyncOutbox.findMany({
    where: {
      sourceKey,
      OR: [
        {
          status: OutboxStatus.Pending,
          OR: [
            { attemptCount: { gt: 0 } },
            { permanentAttemptCount: { gt: 0 } },
            { deadLetterRecoveryCount: { gt: 0 } },
            { ackOmittedCycleCount: { gt: 0 } },
            { laneStalledSince: { not: null } },
          ],
        },
        {
          status: OutboxStatus.DeadLettered,
          OR: [
            { deadLetterRecoveryCount: { gt: 0 } },
            { ackOmittedCycleCount: { gt: 0 } },
          ],
        },
      ],
    },
    select: {
      externalSessionId: true,
      status: true,
      attemptCount: true,
      permanentAttemptCount: true,
      deadLetterRecoveryCount: true,
      ackOmittedCycleCount: true,
      nextAttemptAt: true,
      lastError: true,
      laneStalledSince: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) =>
    row.status === OutboxStatus.DeadLettered
      ? {
          id: row.externalSessionId,
          status: OutboxStatus.DeadLettered,
          attemptCount: 0,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: row.deadLetterRecoveryCount,
          ackOmittedCycleCount: row.ackOmittedCycleCount,
          nextAttemptAt: null,
          lastError: null,
          laneStalledSince: null,
        }
      : {
          id: row.externalSessionId,
          attemptCount: row.attemptCount,
          permanentAttemptCount: row.permanentAttemptCount,
          deadLetterRecoveryCount: row.deadLetterRecoveryCount,
          ackOmittedCycleCount: row.ackOmittedCycleCount,
          nextAttemptAt: row.nextAttemptAt,
          lastError: row.lastError,
          laneStalledSince: row.laneStalledSince,
        }
  );
}

/**
 * FEA-3781: durably flip every `dead_lettered` row on this lane back to
 * `pending` as part of an autonomy-formula re-walk, so each one is recoverable
 * through {@link sqliteLoadPendingOutboxIds} no matter where a crash lands.
 * Bulk twin of {@link sqliteReEnqueueRecoveredDeadLetter}, and like it, resets
 * live retry counters while preserving the durable recovery ladder until a
 * verified ack clears the row.
 *
 * Scoped by `sourceKey`, so it only ever touches the lane whose formula moved.
 * Called by `sqliteLoadSyncState` in `sync-cursor-state.ts` — see the rationale
 * for why the flip must land on disk BEFORE the fresh cursor is stamped.
 */
export async function sqliteRependDeadLetteredForFormulaRewalk(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.updateMany({
      where: { sourceKey, status: OutboxStatus.DeadLettered },
      // PLN-1562: the shared re-pend field shape — back to `pending` with the
      // live retry budget restarted from scratch. ISS-7730: the lane-stall clock
      // restarts with it, or a recovered row would inherit an already-expired run
      // and be abandoned again on its first 5xx. The durable recovery ladder stays
      // until a verified ack clears the row.
      data: {
        ...outboxRePendFields(now),
        pendingSince: now,
        laneStalledSince: null,
        permanentAttemptCount: 0,
      },
    })
  );
}

/**
 * ISS-4447: max ids per batched outbox `INSERT … ON CONFLICT` statement. Bounds
 * the SQL text / positional-parameter count of a single write (4 params per row)
 * so a very large candidate/backfill set is split across a few statements rather
 * than one gigantic one, while still collapsing the former per-id round-trips.
 */
const OUTBOX_ENQUEUE_CHUNK_SIZE = 200;

function chunkOutboxEntries(
  entries: AgentSessionOutboxEntry[],
  size: number
): AgentSessionOutboxEntry[][] {
  if (entries.length <= size) {
    return [entries];
  }
  const chunks: AgentSessionOutboxEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    chunks.push(entries.slice(i, i + size));
  }
  return chunks;
}

/**
 * ISS-4447: build the batched outbox upsert for `rowCount` rows. Each row binds
 * 4 positional params (external_session_id, status, sync_class, timestamp); the
 * `source_key` is a single trailing param shared by every row. The ON CONFLICT
 * clause refreshes `sync_class`/`updated_at` only and NEVER touches `status`, so
 * a re-enqueue of a `dead_lettered` id is not silently resurrected as `pending`
 * — matching the prior per-id `upsert`'s `update` clause exactly.
 */
export function buildOutboxUpsertSql(rowCount: number): string {
  const sourceKeyParam = `$${rowCount * 4 + 1}`;
  const valuesClauses: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const base = i * 4;
    // (source_key, external_session_id, status, sync_class, attempt_count,
    //  pending_since, created_at, updated_at)
    valuesClauses.push(
      `(${sourceKeyParam}, $${base + 1}, $${base + 2}, $${base + 3}, 0, $${base + 4}, $${base + 4}, $${base + 4})`
    );
  }
  return `INSERT INTO agent_session_sync_outbox
            (source_key, external_session_id, status, sync_class, attempt_count, pending_since, created_at, updated_at)
          VALUES ${valuesClauses.join(", ")}
          ON CONFLICT(source_key, external_session_id) DO UPDATE SET
            sync_class = excluded.sync_class,
            updated_at = excluded.updated_at`;
}

/**
 * ISS-4447: positional params for {@link buildOutboxUpsertSql}. Per-row params
 * come first (external_session_id, status, sync_class, now), then the shared
 * `source_key` trailing param the SQL references as `$rowCount*4+1`.
 */
export function buildOutboxUpsertParams(
  sourceKey: string,
  now: string,
  entries: AgentSessionOutboxEntry[]
): string[] {
  const params: string[] = [];
  for (const entry of entries) {
    params.push(
      entry.externalSessionId,
      OutboxStatus.Pending,
      entry.syncClass,
      now
    );
  }
  params.push(sourceKey);
  return params;
}

/**
 * `AgentSessionSyncOutbox` is keyed on the compound
 * `@@id([sourceKey, externalSessionId])` and has no `id` column, so this select
 * IS the whole primary key.
 */
const OUTBOX_ROW_SELECT = {
  sourceKey: true,
  externalSessionId: true,
} as const;

/**
 * ISS-7246: durably mark rows `withheld` — sessions the drain judged
 * unsubstantive, which owe the cloud nothing until they gain activity.
 *
 * Before this existed the withhold was in-memory only, so the row stayed
 * `pending`, `reconcilePendingOutboxIfIdle` re-armed it on the next idle tick,
 * and the session cycled forever. The row is NOT deleted: the retention sweep's
 * undelivered probe asks only whether a row exists (any key, any status), so
 * keeping it preserves purge behavior exactly.
 *
 * `updateMany` scoped to `status = pending` (never `update`): a missing row is a
 * 0-row no-op rather than a throw, and the guard means a `dead_lettered` row can
 * never be silently re-flagged as merely-withheld, which would drop it out of
 * the dead-letter recovery lifecycle.
 */
export async function sqliteMarkOutboxWithheld(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await prisma.write(
    (client) =>
      client.agentSessionSyncOutbox.updateMany({
        where: {
          sourceKey,
          externalSessionId: { in: ids },
          status: OutboxStatus.Pending,
        },
        data: outboxWithheldFields(now),
      }),
    undefined,
    // A withhold batch lands alongside the drain's own bulk writes (a
    // phantom-heavy corpus withholds in batches), so it takes the same class as
    // the enqueue and the ack clear rather than jumping the interactive lane.
    { class: WriteQueueClass.Bulk }
  );
}

/**
 * ISS-7246: flip `withheld` rows back to `pending` when their session gains new
 * local activity, restarting the retry budget from scratch.
 *
 * This is the load-bearing half of the withhold. `sqliteEnqueueOutboxEntries`'s
 * `ON CONFLICT` clause deliberately never touches `status` (so a re-enqueue
 * cannot resurrect a dead-letter), which means a re-enqueued withheld row would
 * otherwise stay withheld forever and the session would never upload.
 *
 * The `WHERE status = withheld` guard is what keeps that safe in the other
 * direction: it cannot resurrect a `dead_lettered` row, and it cannot reset the
 * budget of an in-flight `pending` retry.
 */
export async function sqliteRePendWithheldOutbox(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await prisma.write(
    (client) =>
      client.agentSessionSyncOutbox.updateMany({
        where: {
          sourceKey,
          externalSessionId: { in: ids },
          status: OutboxStatus.Withheld,
        },
        // ISS-7730: see the recovered-dead-letter re-pend above.
        data: {
          ...outboxRePendFields(now),
          pendingSince: now,
          laneStalledSince: null,
          permanentAttemptCount: 0,
          deadLetterRecoveryCount: 0,
        },
      }),
    undefined,
    { class: WriteQueueClass.Bulk }
  );
}

/**
 * ISS-7730: end the durable lane-wide stall run for `ids` — the server answered
 * a verdict ABOUT THE ROW (a 400 validation rejection, a server-answered 408),
 * which is proof the lane is reachable and the stall is over. Mirrors the
 * transcript lane, whose `lane_stalled_since` is likewise cleared by any
 * row-attributable failure.
 *
 * Needed as its own write because the row-attributable defer classes carry an
 * in-memory-only budget and issue no other durable write, so without this the
 * column would keep a stale run on disk and a relaunch would rehydrate it — then
 * the row's next 5xx would look like the end of a day-long outage and abandon a
 * session on a healthy lane.
 *
 * Scoped `status = pending`: a re-pend already clears the column, and this must
 * not touch a `dead_lettered` row, whose stamp is evidence of why it was
 * abandoned. Touches no other column, so it can never reset a live budget.
 */
export async function sqliteClearOutboxLaneStall(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.updateMany({
      where: {
        sourceKey,
        externalSessionId: { in: ids },
        status: OutboxStatus.Pending,
      },
      data: { laneStalledSince: null, updatedAt: new Date().toISOString() },
    })
  );
}

/**
 * ISS-8271 (PLN-1839 Step 3): rows one boot-time redrive pass will re-pend PER
 * CLASS, bounding the per-boot work so a pathological backlog cannot stall the
 * cursor load. Mirrors the invocation lane's `REDRIVE_SESSION_PAGE` scale.
 * Each class is bounded independently (cr-72087 bha_p0_f1) and each window
 * SELF-ADVANCES (PR #6165 review, whitlockk): eligibility is filtered inside the
 * query and both reads order by `updated_at asc`, so a row the pass re-pends
 * (and that later re-dead-letters with a fresh `updated_at`) moves to the BACK
 * of the window — a backlog larger than the limit drains across boots instead
 * of the same prefix being re-selected forever.
 */
const SESSION_DEAD_LETTER_REDRIVE_LIMIT = 200;

/**
 * ISS-8271 (PR #6165 review, whitlockk): how old an `ack_omitted` dead-letter must
 * be before the boot redrive re-pends it. The per-boot retry is the designed
 * wake-up — the cloud cannot signal re-admission (installed desktops parse the
 * success ack `.strict()`), so a restart is the only lever — but without a
 * floor, rapid back-to-back restarts would each buy a still-held row a fresh
 * 5-attempt/3-cycle allowance. One hour skips a row re-dead-lettered THIS
 * boot-hour while leaving the legitimate case untouched: a hold the cloud has
 * since become able to accept was dead-lettered well before the restart.
 */
export const SESSION_ACK_OMITTED_REDRIVE_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * ISS-8271 (cr-72087 bhb_f0): how old a `validation_failed` dead-letter must be
 * before the boot redrive will touch it. `validation_failed` is NOT exclusive
 * to the sentinel-revision stranding — it is the generic whole-session
 * rejection reason (`chunkFailureReason`, FEA-3366), and `data_revision >= 1`
 * is true for nearly every session — so an unconditional per-boot re-pend would
 * re-run the batch-400 + bisect cycle for every permanently-invalid session on
 * every launch, exactly the pointless re-detect loop the Row class's infinite
 * in-memory deadline exists to prevent. The age gate keeps the intent without a
 * marker column: the pre-fix stranded fleet (dead-lettered days–weeks ago) is
 * eligible immediately, while a row the post-fix cloud freshly re-rejected
 * retries at most once per week — still often enough that a cloud-side schema
 * fix eventually heals it, and orders of magnitude quieter than per-boot.
 */
export const SESSION_VALIDATION_REDRIVE_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ISS-8271 (PLN-1839 Step 3): the session-lane dead-letters a boot may re-drive
 * — parity with the invocation lane's `redriveValidationFailedInvocationParts`.
 * Read-only; the durable flip is {@link sqliteRependSessionDeadLetters}. Two
 * classes qualify:
 *
 *  - `last_error = 'validation_failed'` where the local session row NOW carries
 *    a real `data_revision` AND the dead-letter is at least
 *    {@link SESSION_VALIDATION_REDRIVE_MIN_AGE_MS} old. The pre-ISS-8271 cloud
 *    batch-400'd a sentinel revision and the row terminally dead-lettered; the
 *    reseal stamps only `data_revision` (deliberately no `updated_at` bump), so
 *    nothing else ever re-sends the healed session — recovery used to depend on
 *    `promoteDeadLetterIfIdle` luck. The revision condition keeps a
 *    still-unsealed row (healed only by a later boot's rebuild) from burning a
 *    fresh retry budget every boot; a session row that is GONE is likewise left
 *    alone (re-driving it would only re-dead-letter as `unhydratable`); and the
 *    age gate keeps the generic (non-revision) rejections this reason also
 *    covers from re-running their doomed sends on every launch.
 *  - `last_error = 'ack_omitted'`, gated by
 *    {@link SESSION_ACK_OMITTED_REDRIVE_MIN_AGE_MS} and, since ISS-9182, by the
 *    durable `ack_omitted_cycle_count`. A held-class row exhausts its bounded
 *    5-attempt/3-cycle budget and goes terminal with no wake-up when the cloud
 *    catches up — installed desktops parse the success ack `.strict()`, so the
 *    cloud cannot signal re-admission. A boot-time re-pend makes an app restart
 *    a retry that survives the cloud upgrading, but only while the row has
 *    cycles left: `ackOmittedCycleById` restarts at zero every launch, so an
 *    in-memory count alone granted a permanently-held row a fresh three cycles
 *    per boot.
 *
 *    This arm is one of two readers of the count. The resume seeds
 *    `ackOmittedCycleById` from it, so a row re-driven through ANY door after a
 *    restart gets only the recoverable cycles it has left. What neither reader
 *    stops is `promoteDeadLetterIfIdle`, which revisits a set-aside row once per
 *    idle cycle whatever its count: that lowest-priority trickle is the path
 *    back for a hold the cloud later lifts, `revision_too_new` included — the
 *    desktop cannot tell that hold from any other omission, so it is bounded
 *    here like the rest. With the seeded map a spent row's next dead-letter is
 *    terminal, rather than a fresh recoverable cycle.
 *
 * Routed through `prisma.read` (PR #6165 review, davetho): this is a
 * boot-time recovery scan, not a light co-located cursor read, so it belongs
 * on the query-only pool rather than contending with the writer.
 */
export async function sqliteSelectRedrivableSessionDeadLetters(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<string[]> {
  const nowMs = Date.now();
  const ackOmittedCutoff = new Date(
    nowMs - SESSION_ACK_OMITTED_REDRIVE_MIN_AGE_MS
  ).toISOString();
  const validationCutoff = new Date(
    nowMs - SESSION_VALIDATION_REDRIVE_MIN_AGE_MS
  ).toISOString();
  const [ackOmittedRows, healedRows] = await prisma.read((reader) =>
    Promise.all([
      reader.agentSessionSyncOutbox.findMany({
        where: {
          sourceKey,
          status: OutboxStatus.DeadLettered,
          lastError: SyncReason.AckOmitted,
          // ISO-8601 strings, so lexicographic `lt` is chronological.
          updatedAt: { lt: ackOmittedCutoff },
          // ISS-9182: filtered INSIDE the query, like the sibling arm's
          // eligibility, so a prefix of rows that have spent the budget cannot
          // shadow a row behind them that still has some.
          ackOmittedCycleCount: { lt: MAX_ACK_OMITTED_DEAD_LETTERS },
        },
        select: { externalSessionId: true },
        orderBy: { updatedAt: "asc" },
        take: SESSION_DEAD_LETTER_REDRIVE_LIMIT,
      }),
      // The `validation_failed` half filters eligibility IN the query — the
      // healed-revision join included — so an unhealed or session-less row
      // consumes no window slot at all (PR #6165 review, whitlockk: a large
      // ineligible prefix must not shadow a healed row behind it). The desktop
      // stores the external session id AS the local `sessions.id`, so the
      // outbox key joins the session row directly.
      // lexical-timestamp-ok: `agent_session_sync_outbox.updated_at` is written
      // exclusively by this module, and every writer stamps
      // `new Date().toISOString()` — fixed-width canonical UTC — so the byte
      // order of the `ORDER BY` (and the `<` cutoff) is time order. The
      // ordering is fairness-only besides: a mis-ranked row would shift its
      // window slot, never corrupt data.
      reader.$queryRawUnsafe<RedrivableOutboxRow[]>(
        `SELECT o.external_session_id
           FROM agent_session_sync_outbox o
           JOIN sessions s ON s.id = o.external_session_id
          WHERE o.source_key = $1
            AND o.status = $2
            AND o.last_error = $3
            AND o.updated_at < $4
            AND s.data_revision >= $5
          ORDER BY o.updated_at ASC
          LIMIT ${SESSION_DEAD_LETTER_REDRIVE_LIMIT}`,
        sourceKey,
        OutboxStatus.DeadLettered,
        VALIDATION_FAILED_REASON,
        validationCutoff,
        MIN_REAL_DATA_REVISION
      ),
    ])
  );
  return [
    ...ackOmittedRows.map((row) => row.externalSessionId),
    ...healedRows.map((row) => row.external_session_id),
  ];
}

/** One row of the raw `validation_failed` eligibility join. */
type RedrivableOutboxRow = { external_session_id: string };

/**
 * ISS-8271 (PLN-1839 Step 3): durably re-pend the given session dead-letters —
 * the write half of {@link sqliteSelectRedrivableSessionDeadLetters}. Targeted
 * twin of {@link sqliteRependDeadLetteredForFormulaRewalk}: same re-pend field
 * shape (live retry budget restarted, recovery ladder preserved, ISS-7730
 * lane-stall clock cleared), same `status = dead_lettered` guard so an
 * in-flight `pending` retry is never reset out from under itself, but scoped to
 * the ids one redrive pass selected rather than the whole lane.
 */
export async function sqliteRependSessionDeadLetters(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.updateMany({
      where: {
        sourceKey,
        externalSessionId: { in: ids },
        status: OutboxStatus.DeadLettered,
      },
      data: {
        ...outboxRePendFields(now),
        pendingSince: now,
        laneStalledSince: null,
        permanentAttemptCount: 0,
      },
    })
  );
}

/**
 * ISS-11427: which of `ids` still have a `dead_lettered` outbox row under
 * `sourceKey`. The cursor-load prune keeps only these; a row a verified ack
 * deleted, or a recovery door re-pended, is no longer set aside. `ids` is the
 * cursor's dead-letter list, bounded by `MAX_DEAD_LETTERED_IDS`.
 */
export async function sqliteSelectDeadLetteredSessionIds(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: readonly string[]
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) {
    return new Set();
  }
  const rows = await prisma.client.agentSessionSyncOutbox.findMany({
    where: {
      sourceKey,
      status: OutboxStatus.DeadLettered,
      externalSessionId: { in: [...ids] },
    },
    select: { externalSessionId: true },
  });
  return new Set(rows.map((row) => row.externalSessionId));
}
