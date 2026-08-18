/**
 * @file invocation-sync-pending-templates.ts
 * @description The invocation-parts lane's PENDING PREDICATE — the query that
 * answers "which sessions does the target-scoped delivery queue still owe?".
 *
 * Extracted from `sync-source.ts` (ISS-5387) so it has exactly one definition
 * and two callers: the prepare `$transaction` that materializes delivery rows,
 * and the burn-down reader that reports how many are outstanding. Before the
 * extraction the prepare path owned it privately, and any other reader of
 * `agent_component_invocation_sync_outbox` had to re-derive the scoping rule.
 *
 * ## Why re-deriving it is a trap
 *
 * `agent_component_invocation_sync_outbox` is keyed by `source_key`, and TWO
 * different kinds of key live in that column:
 *
 *  - the **template** key — the unscoped `agent_component_invocations`, holding
 *    the per-session latest-generation rows the lane clones FROM, and
 *  - the **delivery** key — `agent_component_invocations:<computeTargetId>`,
 *    the target-scoped queue the lane actually drains.
 *
 * On one live install (2026-08-06) that table held 3,508 `pending` rows, of
 * which **3,490 sat under the template key** and only 18 under the delivery key.
 * A count of `WHERE status = 'pending'` therefore reports a 3,490-item cloud
 * backlog that does not exist — the template rows are never-attempted
 * definitions (`attempt_count = 0`, `last_error NULL`), not undelivered work.
 *
 * Anything reporting invocation-lane depth MUST go through this module rather
 * than counting rows by status.
 */

import { OutboxStatus } from "../../shared/sync-lane-contract.js";

/**
 * The minimal raw-read surface this predicate needs. Structural rather than
 * `Prisma.TransactionClient` so the same query serves both callers: the prepare
 * path runs it inside a write `$transaction`, and the burn-down reader runs it
 * on the reader pool.
 */
export type RawQueryClient = {
  $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
};

/** One session the delivery queue still owes, projected by session id only. */
export type PendingInvocationTemplate = {
  external_session_id: string;
};

/**
 * The sessions whose template generation is NEWER than what the target-scoped
 * queue has delivered, keyset-paged after `afterSessionId`.
 *
 * A session qualifies only when the template still has at least one `pending`
 * outbox row of its own — a template whose parts were all cleared has nothing
 * left to clone, so counting it would inflate the backlog with settled work.
 */
export function loadPendingInvocationTemplates(
  tx: RawQueryClient,
  targetSourceKey: string,
  templateSourceKey: string,
  afterSessionId: string,
  limit: number
): Promise<PendingInvocationTemplate[]> {
  return tx.$queryRawUnsafe<PendingInvocationTemplate[]>(
    `SELECT template.external_session_id
       FROM agent_component_invocation_sync_cursors template
       LEFT JOIN agent_component_invocation_sync_cursors target
         ON target.source_key = $1
        AND target.external_session_id = template.external_session_id
      WHERE template.source_key = $2
        AND template.external_session_id > $3
        AND (target.source_sequence IS NULL OR
             target.source_sequence < template.source_sequence)
        AND EXISTS (
          SELECT 1
            FROM agent_component_invocation_sync_outbox outbox
           WHERE outbox.source_key = $2
             AND outbox.external_session_id = template.external_session_id
             AND outbox.external_generation_id = template.external_generation_id
             AND outbox.status = $4
        )
      ORDER BY template.external_session_id
      LIMIT $5`,
    targetSourceKey,
    templateSourceKey,
    afterSessionId,
    OutboxStatus.Pending,
    limit
  );
}

/**
 * ISS-5789 (PRD-635 layer 3): the depth at or above which promotion defers for a
 * tick.
 *
 * The promotion step used to bail whenever the delivery queue held ANY pending
 * row, which conflated two completely different conditions: "a batch is healthily
 * draining" and "one poisoned row will never drain". The second one converted a
 * single stuck part into a TOTAL outage — 225 queued records, including all 18
 * from 9 recent sessions, were never even attempted, because one orphaned part
 * from July 24th sat `pending` forever. Depth is the honest expression of the
 * throttle that guard was reaching for: it still stops the delivery queue growing
 * without bound while nothing drains, but a queue of one can no longer wedge every
 * other session behind it.
 *
 * Sized well above a normal working set (a live install carried 18 delivery rows
 * against 3,490 template rows) so it engages only on a genuine, sustained backlog.
 */
export const MAX_PENDING_INVOCATION_DELIVERY_PARTS = 500;

/**
 * Which of `candidateSessionIds` already have `pending` rows in the TARGET-scoped
 * delivery queue.
 *
 * These are the sessions promotion must leave alone: it re-materializes a session
 * by DELETEing that session's delivery rows and re-cloning them, which would
 * discard in-flight attempt counts and backoff deadlines — and, for a part the
 * lane is mid-way through retrying, silently reset the bounded budget that
 * invariant 5 requires to stay reachable.
 *
 * Scoped to the candidates rather than the whole queue so the read stays keyed and
 * bounded by the promotion batch size.
 */
export async function loadBlockedInvocationDeliverySessionIds(
  tx: RawQueryClient,
  targetSourceKey: string,
  candidateSessionIds: readonly string[]
): Promise<string[]> {
  if (candidateSessionIds.length === 0) {
    return [];
  }
  const placeholders = candidateSessionIds
    .map((_, index) => `$${index + 3}`)
    .join(", ");
  const rows = await tx.$queryRawUnsafe<{ external_session_id: string }[]>(
    `SELECT DISTINCT external_session_id
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1
        AND status = $2
        AND external_session_id IN (${placeholders})`,
    targetSourceKey,
    OutboxStatus.Pending,
    ...candidateSessionIds
  );
  return rows.map((row) => row.external_session_id);
}

/**
 * The candidates promotion may materialize this pass: every candidate that is not
 * currently blocked by its own in-flight delivery rows.
 *
 * Pure so the skip-one-continue-with-the-rest rule is unit-testable without a
 * database. Order is preserved because the caller advances a keyset cursor to the
 * LAST id it promoted.
 */
export function selectPromotableInvocationSessions(
  candidateSessionIds: readonly string[],
  blockedSessionIds: readonly string[]
): string[] {
  const blocked = new Set(blockedSessionIds);
  return candidateSessionIds.filter((sessionId) => !blocked.has(sessionId));
}

/**
 * ISS-5789 (@wongk review): how many delivery rows each candidate session would
 * ADD if it were promoted this pass.
 *
 * The depth guard in `invocation-sync-promotion.ts` used to be a pre-insert check
 * only, which bounded the queue's size BEFORE the clone and not after it: at 499
 * pending rows a pass could still admit ten 1,000-part generations and leave 10,499
 * rows in one transaction — measured, and exactly the blow-out @wongk described.
 * Bounding it properly means knowing the cost of a candidate before admitting it.
 *
 * The predicate mirrors the clone's own `SELECT` (same template `source_key`, same
 * `pending` status, same join to the template cursor's generation) so the count and
 * the insert cannot disagree about what a session is worth. The promotion suite
 * asserts on the resulting queue depth rather than on this number, so a drift
 * between the two surfaces as a failing ceiling rather than a passing count.
 */
export async function loadInvocationTemplatePartCounts(
  tx: RawQueryClient,
  templateSourceKey: string,
  candidateSessionIds: readonly string[]
): Promise<Map<string, number>> {
  if (candidateSessionIds.length === 0) {
    return new Map();
  }
  const placeholders = candidateSessionIds
    .map((_, index) => `$${index + 3}`)
    .join(", ");
  const rows = await tx.$queryRawUnsafe<
    { external_session_id: string; part_count: number | bigint }[]
  >(
    `SELECT outbox.external_session_id, COUNT(*) AS part_count
       FROM agent_component_invocation_sync_outbox outbox
       JOIN agent_component_invocation_sync_cursors template
         ON template.source_key = $1
        AND template.external_session_id = outbox.external_session_id
        AND template.external_generation_id = outbox.external_generation_id
      WHERE outbox.source_key = $1
        AND outbox.status = $2
        AND outbox.external_session_id IN (${placeholders})
      GROUP BY outbox.external_session_id`,
    templateSourceKey,
    OutboxStatus.Pending,
    ...candidateSessionIds
  );
  return new Map(
    rows.map((row) => [row.external_session_id, Number(row.part_count)])
  );
}

/**
 * ISS-5789 (@wongk review): the prefix of `sessionIds` that fits in
 * `remainingPartBudget`, so the delivery queue respects
 * {@link MAX_PENDING_INVOCATION_DELIVERY_PARTS} AFTER the clone rather than only
 * before it.
 *
 * Two deliberate properties:
 *
 *  - it takes a PREFIX and stops at the first session that does not fit, rather
 *    than skipping that session and admitting a smaller one behind it. The caller
 *    advances a keyset cursor to the LAST id it promoted, so a hole in the middle
 *    of the admitted set would move the cursor past a session that was never
 *    promoted and strand it until the sweep wrapped.
 *  - when nothing fits, the pass admits the leading candidate ONLY if it could
 *    never fit — that is, if its own generation is larger than the whole
 *    {@link MAX_PENDING_INVOCATION_DELIVERY_PARTS} ceiling. That is the bounded
 *    oversized-generation path: such a session is unpromotable at EVERY queue
 *    depth, so deferring it is not waiting, it is stranding it forever. It is
 *    promoted ALONE, so one pass overshoots by at most that single generation
 *    instead of stacking ten of them, and the next pass sees a queue over depth
 *    and defers. A generation that merely does not fit RIGHT NOW is left to wait
 *    for the queue to drain, which layer 2's bounded budgets guarantee it will.
 *
 * A candidate missing from `partCountBySession` counts as 0: it has no pending
 * template rows to clone, so admitting it costs nothing and it must not block the
 * prefix behind it.
 *
 * Pure so the admission rule is unit-testable without a database.
 */
export function selectSessionsWithinPartBudget(
  sessionIds: readonly string[],
  partCountBySession: ReadonlyMap<string, number>,
  remainingPartBudget: number
): string[] {
  const admitted: string[] = [];
  let usedParts = 0;
  for (const sessionId of sessionIds) {
    const parts = partCountBySession.get(sessionId) ?? 0;
    if (usedParts + parts > remainingPartBudget) {
      if (
        admitted.length === 0 &&
        parts > MAX_PENDING_INVOCATION_DELIVERY_PARTS
      ) {
        admitted.push(sessionId);
      }
      break;
    }
    admitted.push(sessionId);
    usedParts += parts;
  }
  return admitted;
}
