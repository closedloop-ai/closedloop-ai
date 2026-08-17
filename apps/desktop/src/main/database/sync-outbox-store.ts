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

import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import type {
  AgentSessionOutboxEntry,
  OutboxRetryState,
} from "../agent-sync/agent-session-sync-source.js";
import {
  outboxDeadLetterFields,
  outboxRePendFields,
  outboxRetryFields,
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
 */
export async function sqliteClearOutboxEntries(
  prisma: DesktopPrisma,
  sourceKey: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  // ISS-4710: verified-ack clears fire in bulk as a large backfill drains, so tag
  // them `bulk` for the same writer-fairness reason as the enqueue above.
  await prisma.write(
    (client) =>
      client.agentSessionSyncOutbox.deleteMany({
        where: { sourceKey, externalSessionId: { in: ids } },
      }),
    undefined,
    { class: WriteQueueClass.Bulk }
  );
}

/**
 * FEA-3659: durably record a transient outbox retry with backoff — stamp the
 * incremented `attempt_count`, the `next_attempt_at` deadline, and the
 * `last_error` class, WITHOUT flipping the row to `dead_lettered`. This is the
 * persisted twin of the in-memory per-session retry budget: a transient
 * rejection defers here with a growing `attempt_count`, so the durable outbox
 * reflects that the row is mid-backoff instead of misreporting
 * `attempt_count=0`. Today only the `ingestion_failed` defer branch calls this;
 * `rate_limited` / `ack_timeout` still defer with an in-memory-only budget.
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
 * never re-enqueues the row yet `loadPendingOutboxRetryState` would seed a live
 * budget for it. This mirrors the `FakeSyncSource.recordOutboxRetry` test fake,
 * which likewise preserves the existing status.
 */
export async function sqliteRecordOutboxRetry(
  prisma: DesktopPrisma,
  sourceKey: string,
  id: string,
  attemptCount: number,
  nextAttemptAt: string,
  reason: string
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
        nextAttemptAt,
        lastError: reason,
        createdAt: now,
        updatedAt: now,
      },
      // FEA-3659: the update branch leaves `status` untouched so a retry write
      // can never resurrect a dead_lettered row; recordOutboxRetry is only
      // invoked on still-pending rows, and dead-lettered ids are excluded from
      // the retry queues. PLN-1562: `outboxRetryFields` omits `status` for
      // exactly that reason, so the invariant is now carried by the shared
      // builder rather than by remembering not to add the column here.
      update: outboxRetryFields({
        attemptCount,
        nextAttemptAt,
        reason,
        nowIso: now,
      }),
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
 */
export async function sqliteMarkOutboxDeadLettered(
  prisma: DesktopPrisma,
  sourceKey: string,
  id: string,
  reason: string,
  attemptCount = 0
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
        status: OutboxStatus.DeadLettered,
        syncClass: "backfill",
        attemptCount,
        nextAttemptAt: null,
        lastError: reason,
        createdAt: now,
        updatedAt: now,
      },
      // PLN-1562: the shared dead-letter field shape, carrying the real burned
      // attempt count (FEA-3659) rather than a misleading 0.
      update: outboxDeadLetterFields({ reason, attemptCount, nowIso: now }),
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
 */
export async function sqliteReEnqueueRecoveredDeadLetter(
  prisma: DesktopPrisma,
  sourceKey: string,
  id: string
): Promise<void> {
  const now = new Date().toISOString();
  await prisma.write((client) =>
    client.agentSessionSyncOutbox.updateMany({
      where: {
        sourceKey,
        externalSessionId: id,
        status: OutboxStatus.DeadLettered,
      },
      // PLN-1562: the shared re-pend field shape — back to `pending` with the
      // bounded retry/dead-letter budget restarted from scratch.
      data: outboxRePendFields(now),
    })
  );
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
 * FEA-3659: the persisted retry state for still-`pending` rows that recorded a
 * transient backoff (`attempt_count > 0`). Read once on resume so the in-memory
 * per-session retry budget and deferred-retry deadline are rehydrated from the
 * durable outbox — otherwise a restart mid-backoff retries the row immediately
 * and recomputes `attempt_count` from 0, silently discarding a partly-burned
 * dead-letter budget and the persisted `next_attempt_at`. Only rows with a
 * recorded attempt are returned (a fresh pending row has nothing to seed).
 */
export async function sqliteLoadPendingOutboxRetryState(
  prisma: DesktopPrisma,
  sourceKey: string
): Promise<OutboxRetryState[]> {
  const rows = await prisma.client.agentSessionSyncOutbox.findMany({
    where: {
      sourceKey,
      status: OutboxStatus.Pending,
      attemptCount: { gt: 0 },
    },
    select: {
      externalSessionId: true,
      attemptCount: true,
      nextAttemptAt: true,
      lastError: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({
    id: row.externalSessionId,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
  }));
}

/**
 * FEA-3781: durably flip every `dead_lettered` row on this lane back to
 * `pending` as part of an autonomy-formula re-walk, so each one is recoverable
 * through {@link sqliteLoadPendingOutboxIds} no matter where a crash lands.
 * Bulk twin of {@link sqliteReEnqueueRecoveredDeadLetter}, and like it, resets
 * the retry budget so a recovered row starts from scratch.
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
      // bounded retry/dead-letter budget restarted from scratch.
      data: outboxRePendFields(now),
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
function buildOutboxUpsertSql(rowCount: number): string {
  const sourceKeyParam = `$${rowCount * 4 + 1}`;
  const valuesClauses: string[] = [];
  for (let i = 0; i < rowCount; i += 1) {
    const base = i * 4;
    // (source_key, external_session_id, status, sync_class, attempt_count,
    //  created_at, updated_at)
    valuesClauses.push(
      `(${sourceKeyParam}, $${base + 1}, $${base + 2}, $${base + 3}, 0, $${base + 4}, $${base + 4})`
    );
  }
  return `INSERT INTO agent_session_sync_outbox
            (source_key, external_session_id, status, sync_class, attempt_count, created_at, updated_at)
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
function buildOutboxUpsertParams(
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
