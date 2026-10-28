/**
 * @file invocation-sync-outbox-parts.ts
 * @description The READY-PARTS read over the agent-component invocation outbox
 * (`agent_component_invocation_sync_outbox`), plus the payload-validation
 * quarantine that dead-letters a row whose persisted payload no longer parses.
 *
 * One table, one module — the same split `sync-outbox-store.ts` (the per-SESSION
 * outbox) and `sync-cursor-state.ts` already apply, extracted out of
 * `sync-source.ts` (which is about BUILDING sync payloads, not owning delivery
 * state). `sync-source.ts` delegates `loadReadyInvocationSyncParts` here
 * one-for-one, so the ready-row parsing rules have one owner.
 *
 * ISS-4710: the ready-parts probe reads through the READER pool
 * (`prisma.read`), never `prisma.client` (the single writer connection) — see
 * {@link loadReadyInvocationSyncOutboxParts}. The quarantine write still routes
 * through `prisma.write` so it serializes on the write queue.
 */

import {
  type AgentComponentInvocationSyncPart,
  isSupportedAgentComponentInvocationSyncProtocolVersion,
} from "@repo/api/src/types/agent-component-invocation";
import { OutboxStatus } from "../../shared/sync-lane-contract.js";
import { AgentComponentInvocationSyncLocalError } from "../agent-sync/agent-component-invocation-sync-constants.js";
import type { AgentComponentInvocationSyncOutboxEntry } from "../agent-sync/agent-component-invocation-sync-service.js";
import {
  outboxDeadLetterFields,
  readyOutboxWhere,
} from "../sync/durable-outbox.js";
import type { RawQueryClient } from "./invocation-sync-pending-templates.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Identity of one outbox row, enough to target it in a `updateMany` predicate. */
type InvocationSyncOutboxRowIdentity = {
  sourceKey: string;
  externalSessionId: string;
  externalGenerationId: string;
  partIndex: number;
};

type InvalidInvocationSyncOutboxRow = InvocationSyncOutboxRowIdentity & {
  reason: string;
};

type InvocationSyncDurabilityCounters = {
  attemptCount: number;
  permanentAttemptCount: number;
  deadLetterRecoveryCount: number;
};

/**
 * Ready (pending, past its backoff) invocation-sync parts for one source key.
 *
 * ISS-4710 (@whitlockk): the probe routes through the reader pool, NOT
 * `prisma.client` (the single writer connection). This is the "cheap
 * reader-path load" the service runs BEFORE the heavy prepare so it can drain
 * already-materialized parts DURING a bulk rebuild; on the writer connection a
 * held rebuild `$transaction` would park it and defeat the whole non-blocking
 * design. Readers see the committed WAL snapshot concurrently with the writer.
 *
 * A row whose persisted payload no longer parses is not returned and not left
 * to spin: it is dead-lettered in one batched write before this returns, so the
 * lane never re-reads a payload it can never deliver.
 */
export async function loadReadyInvocationSyncOutboxParts(
  prisma: Pick<DesktopPrisma, "read" | "write">,
  sourceKey: string,
  now: string,
  limit: number
): Promise<AgentComponentInvocationSyncOutboxEntry[]> {
  const effectiveLimit = Math.max(1, limit);
  const readySelect = {
    sourceKey: true,
    externalSessionId: true,
    externalGenerationId: true,
    partIndex: true,
    payload: true,
    attemptCount: true,
    permanentAttemptCount: true,
    laneStalledSince: true,
    deadLetterRecoveryCount: true,
    // ISS-5789: the drain budgets `session_missing` by how long the part has
    // been retrying rather than by `attempt_count`, which every transient
    // failure also bumps — so the row's age has to travel with it.
    createdAt: true,
  } as const;
  const readyOrder = [{ createdAt: "asc" }, { partIndex: "asc" }] as const;
  const rows = await prisma.read(async (reader) => {
    // PLN-1562: the shared ready predicate (pending AND past its backoff, scoped
    // to this sourceKey) — same shape every outbox lane drains on.
    // Filter parents BEFORE either bounded window, so zombies cannot spend the
    // FIFO/fairness reservation while maintenance is still draining a backlog.
    const eligibleIds = await loadReadyParentSessionIds(
      reader,
      sourceKey,
      now,
      effectiveLimit
    );
    const readyWhere = {
      ...readyOutboxWhere(sourceKey, now),
      externalSessionId: { in: eligibleIds },
    };
    // The FIFO head. This is the whole read as it stood before ISS-5973, and it
    // still gets first call on the budget: a row that has already been attempted
    // must keep being attempted, or it can never reach the terminal state
    // invariant 5 requires (`session_missing` is budgeted by AGE, but the horizon
    // is only CHARGED when an attempt actually happens).
    // Read a FULL window, not just the reserved share: the reservation below is
    // a FLOOR on fairness, not a ceiling on FIFO. When there are no
    // never-attempted rows to spend it on, the unused half is handed straight
    // back to this list rather than left empty (see mergeReadyOutboxRows).
    const oldest = await reader.agentComponentInvocationSyncOutbox.findMany({
      where: readyWhere,
      select: readySelect,
      orderBy: [...readyOrder],
      take: effectiveLimit,
    });
    // ISS-5973: the FAIRNESS half — the oldest rows that have NEVER been
    // attempted, so a cluster of permanently-ready retrying rows cannot hold the
    // whole window forever.
    //
    // Measured on the live install this ticket was filed from: the delivery queue
    // held 85 ready rows, and `ORDER BY created_at ASC, part_index ASC LIMIT 10`
    // returned exactly ten rows already attempted 4-61 times, every one of them
    // from the four sessions that were failing. The five sessions that had never
    // been attempted at all began at rank 15 and ran to rank 85 — permanently
    // outside the window. That is why 71 rows sat at `attempt_count = 0` for
    // days: not a scheduling failure and not a backoff, simply never selected.
    //
    // Reserving part of every tick's budget for never-attempted rows makes the
    // drain's progress unconditional, and it is deliberately NOT a reordering:
    // the FIFO half above is untouched, so nothing that was being retried stops
    // being retried.
    const neverAttempted =
      await reader.agentComponentInvocationSyncOutbox.findMany({
        where: {
          AND: [
            readyWhere,
            { attemptCount: 0 },
            {
              OR: [
                { deadLetterRecoveryCount: null },
                { deadLetterRecoveryCount: 0 },
              ],
            },
          ],
        },
        select: readySelect,
        orderBy: [...readyOrder],
        take: effectiveLimit,
      });
    return mergeReadyOutboxRows(oldest, neverAttempted, effectiveLimit);
  });
  const entries: AgentComponentInvocationSyncOutboxEntry[] = [];
  const invalidRows: InvalidInvocationSyncOutboxRow[] = [];
  for (const row of rows) {
    const part = parseInvocationSyncPart(row.payload);
    if (!part) {
      invalidRows.push({
        ...row,
        reason: AgentComponentInvocationSyncLocalError.InvalidPersistedPayload,
      });
      continue;
    }
    const counters = readInvocationSyncDurabilityCounters(row);
    if (!counters) {
      invalidRows.push({
        ...row,
        reason:
          AgentComponentInvocationSyncLocalError.InvalidPersistedDurabilityState,
      });
      continue;
    }
    entries.push({
      part,
      attemptCount: counters.attemptCount,
      permanentAttemptCount: counters.permanentAttemptCount,
      laneStalledSince: row.laneStalledSince ?? null,
      deadLetterRecoveryCount: counters.deadLetterRecoveryCount,
      createdAt: row.createdAt,
    });
  }
  await deadLetterInvalidInvocationSyncParts(prisma, invalidRows);
  return entries;
}

/**
 * Narrow a persisted outbox payload back to an
 * {@link AgentComponentInvocationSyncPart}, or null when it does not match a
 * protocol shape this build understands (a version-skewed or corrupt row).
 *
 * ISS-4976 (@tamsinb review): the version test is SET membership against
 * {@link isSupportedAgentComponentInvocationSyncProtocolVersion}, never equality
 * with one constant. This is a LOCAL reader over rows THIS build wrote, so
 * pinning it to a single scalar was not skew tolerance — it silently dropped the
 * producer's own output. Once a telemetry-carrying part started declaring v2,
 * every one of them parsed as `null` here, fell into `invalidRows`, and was
 * quarantined by {@link deadLetterInvalidInvocationSyncParts} before it ever
 * reached the wire: the generation was lost on the machine that captured it,
 * with no server, no peer, and no version skew involved.
 *
 * Reading the shared supported-version tuple keeps the quarantine doing its
 * real job — a corrupt row, or one a FUTURE build wrote in a shape this one
 * cannot interpret, is still turned away rather than spinning forever.
 */
export function parseInvocationSyncPart(
  value: unknown
): AgentComponentInvocationSyncPart | null {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    !isSupportedAgentComponentInvocationSyncProtocolVersion(
      record.protocolVersion
    ) ||
    typeof record.externalSessionId !== "string" ||
    typeof record.externalGenerationId !== "string" ||
    typeof record.sourceUpdatedAt !== "string" ||
    typeof record.dataRevision !== "number" ||
    typeof record.sourceSequence !== "number" ||
    typeof record.partIndex !== "number" ||
    typeof record.partCount !== "number" ||
    typeof record.partHash !== "string" ||
    !Array.isArray(record.items)
  ) {
    return null;
  }
  return record as AgentComponentInvocationSyncPart;
}

/**
 * Quarantine rows whose persisted payload no longer parses. One batched
 * `updateMany` (never a per-row write) so a corrupt batch costs one write-queue
 * slot, and a no-op when nothing was invalid.
 */
async function deadLetterInvalidInvocationSyncParts(
  prisma: Pick<DesktopPrisma, "write">,
  invalidRows: InvalidInvocationSyncOutboxRow[]
): Promise<void> {
  if (invalidRows.length === 0) {
    return;
  }
  await prisma.write(async (client) => {
    for (const [reason, rows] of invalidRowsByReason(invalidRows)) {
      await client.agentComponentInvocationSyncOutbox.updateMany({
        where: {
          status: OutboxStatus.Pending,
          OR: rows.map((row) => ({
            sourceKey: row.sourceKey,
            externalSessionId: row.externalSessionId,
            externalGenerationId: row.externalGenerationId,
            partIndex: row.partIndex,
          })),
        },
        // PLN-1562: a malformed persisted row is not a delivery attempt that
        // burned budget, so the row's counters stay as they were.
        data: outboxDeadLetterFields({
          reason,
          nowIso: new Date().toISOString(),
        }),
      });
    }
  });
}

/**
 * ISS-5973: how much of one tick's budget the plain FIFO head keeps.
 *
 * Half, rounded UP, so the previous behaviour still owns the majority of a small
 * window and a `limit` of 1 degenerates to exactly the old read rather than to a
 * fairness-only one — a lane with a single-row budget must still be able to
 * retire the row it is retrying.
 */
function oldestShareOf(limit: number): number {
  return Math.max(1, Math.ceil(limit / 2));
}

/** The identity that decides whether two ready rows are the same outbox row. */
function readyRowKey(row: InvocationSyncOutboxRowIdentity): string {
  return `${row.sourceKey} ${row.externalSessionId} ${row.externalGenerationId} ${row.partIndex}`;
}

/**
 * Append `rows` to `merged` until it holds `cap` entries, skipping identities
 * already taken. Mutates both accumulators — the caller fills one window in
 * several passes and the dedupe set has to survive across them.
 */
function appendReadyRowsUpTo<T extends InvocationSyncOutboxRowIdentity>(
  merged: T[],
  seen: Set<string>,
  rows: readonly T[],
  cap: number
): void {
  for (const row of rows) {
    if (merged.length >= cap) {
      return;
    }
    const key = readyRowKey(row);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(row);
  }
}

/**
 * ISS-5973: combine the FIFO head with the never-attempted reservation, deduped
 * on row identity and capped at `limit`.
 *
 * Three passes, and the third is the one that keeps the window FULL:
 *
 *  1. the FIFO head, up to {@link oldestShareOf} — its guaranteed share, so a row
 *     already being retried never stops being retried;
 *  2. the never-attempted rows, up to the whole window — the fairness floor;
 *  3. the REST of the FIFO head, back up to the whole window.
 *
 * Pass 3 exists because the reservation is a floor on fairness, not a ceiling on
 * throughput. Capping the FIFO read at half and stopping there would hand back
 * only `ceil(limit / 2)` rows whenever every ready row has already been attempted
 * — the ordinary steady state once a backlog has been worked once — halving
 * retry throughput and letting a handful of permanently-ready transient failures
 * keep later attempted rows outside the window indefinitely. That is the same
 * starvation this ticket exists to remove, merely pointed the other way.
 *
 * The two reads overlap by construction — a never-attempted row that is also
 * among the oldest appears in both — so dedupe is required, not defensive:
 * without it a tick could send the same part twice and burn budget on a
 * duplicate.
 *
 * Order is preserved rather than re-sorted: the caller drains sequentially and
 * the FIFO half must keep going out first.
 */
function mergeReadyOutboxRows<T extends InvocationSyncOutboxRowIdentity>(
  oldest: readonly T[],
  neverAttempted: readonly T[],
  limit: number
): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  appendReadyRowsUpTo(merged, seen, oldest, oldestShareOf(limit));
  appendReadyRowsUpTo(merged, seen, neverAttempted, limit);
  appendReadyRowsUpTo(merged, seen, oldest, limit);
  return merged;
}

function readInvocationSyncDurabilityCounters(input: {
  attemptCount: unknown;
  permanentAttemptCount: unknown;
  deadLetterRecoveryCount: unknown;
}): InvocationSyncDurabilityCounters | null {
  const attemptCount = readRequiredCounter(input.attemptCount);
  const permanentAttemptCount = readOptionalCounter(
    input.permanentAttemptCount
  );
  const deadLetterRecoveryCount = readOptionalCounter(
    input.deadLetterRecoveryCount
  );
  if (
    attemptCount === null ||
    permanentAttemptCount === null ||
    deadLetterRecoveryCount === null
  ) {
    return null;
  }
  return { attemptCount, permanentAttemptCount, deadLetterRecoveryCount };
}

function readRequiredCounter(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : null;
}

function readOptionalCounter(value: unknown): number | null {
  if (value === null || value === undefined) {
    return 0;
  }
  return readRequiredCounter(value);
}

function invalidRowsByReason(
  rows: readonly InvalidInvocationSyncOutboxRow[]
): Map<string, InvalidInvocationSyncOutboxRow[]> {
  const grouped = new Map<string, InvalidInvocationSyncOutboxRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.reason);
    if (bucket) {
      bucket.push(row);
    } else {
      grouped.set(row.reason, [row]);
    }
  }
  return grouped;
}

/** No Prisma relation exists for this deliberately FK-free queue. */
async function loadReadyParentSessionIds(
  reader: RawQueryClient,
  sourceKey: string,
  now: string,
  limit: number
): Promise<string[]> {
  const ready = readyOutboxWhere(sourceKey, now);
  const predicate = `outbox.source_key = $1 AND outbox.status = $2
    AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= $3)
    AND EXISTS (SELECT 1 FROM sessions WHERE sessions.id = outbox.external_session_id)`;
  // This eligibility probe must match the existing Prisma FIFO reads above.
  // Producers stamp canonical UTC; corrupt legacy ages must remain selectable
  // for the lane's persisted-age quarantine rather than be filtered away here.
  const rows = await reader.$queryRawUnsafe<{ externalSessionId: string }[]>(
    // lexical-timestamp-ok: preserve the existing typed FIFO byte-order contract.
    `SELECT external_session_id AS externalSessionId FROM (
       SELECT outbox.external_session_id
         FROM agent_component_invocation_sync_outbox outbox
        WHERE ${predicate}
        ORDER BY outbox.created_at, outbox.part_index LIMIT $4
     ) UNION SELECT external_session_id AS externalSessionId FROM (
       SELECT outbox.external_session_id
         FROM agent_component_invocation_sync_outbox outbox
        WHERE ${predicate}
          AND outbox.attempt_count = 0
          AND (outbox.dead_letter_recovery_count IS NULL OR outbox.dead_letter_recovery_count = 0)
        ORDER BY outbox.created_at, outbox.part_index LIMIT $4
     )`,
    ready.sourceKey,
    ready.status,
    ready.OR[1].nextAttemptAt.lte,
    limit
  );
  return rows.map((row) => row.externalSessionId);
}
