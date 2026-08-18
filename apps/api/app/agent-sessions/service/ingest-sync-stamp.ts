import { type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";

/**
 * ISS-4678 (Problem 2) + ISS-4827: the two per-target session-sync watermarks,
 * stamped from the single ingest boundary that owns them.
 *
 * `lastAgentSessionSyncAt` — the LANDED-DATA watermark, and the SOURCE OF TRUTH
 * the `/cron/sample-session-ingestion-health` stall detector reads (ISS-4543).
 * It must advance ONLY when session data actually landed.
 *
 * `upsertSessions` previously stamped that column unconditionally after the
 * session loop. But `sessions: []` is schema-valid and accepted, and a non-empty
 * batch can persist nothing — every session an all-FOREIGN chunk that hits the
 * `isForeignChunk` skip. Either way zero session rows land, yet the old code
 * still refreshed the watermark, so a desktop stuck posting these accepted no-op
 * batches kept its org looking permanently "actively ingesting" and silently
 * disarmed the stall detector that reads this exact column.
 *
 * `lastAgentSessionSyncAttemptAt` (ISS-4827) — the ATTEMPT watermark. Stamped on
 * EVERY accepted batch, INCLUDING the zero-row batches the landed-data watermark
 * deliberately ignores. This is the signal the stall detector was missing: an
 * old ingest watermark is ambiguous on its own, and the device heartbeat
 * (`lastSeenAt`) cannot disambiguate it, because registration / heartbeat /
 * online check-ins refresh that column on a ~30-90s cadence with no ingest
 * attempt behind them. The pair IS unambiguous — attempt fresh + ingest stale
 * means the fleet is reaching the cloud and its data is not landing (page); both
 * stale means nothing is even trying (an idle-but-open desktop; do not page).
 *
 * It is stamped INSIDE the accepted-batch transaction, so it records a
 * server-observed accepted sync, never a client claim.
 *
 * WHAT THIS WATERMARK CANNOT TESTIFY TO (review, PR #4256). It advances only on
 * SUCCESS, so its absence is NOT evidence that nothing was trying. Three
 * distinct classes leave it untouched, and the stall classifier's contract is
 * exactly this list:
 *
 *   1. Refused BEFORE the batch is accepted — auth, org session-sync policy,
 *      Zod validation. Never an accepted batch, so never stamped. The
 *      fail-closed-policy case is covered far faster by
 *      `session.ingestion.policy_denied`, which fires on the FIRST denied
 *      request rather than after a stall threshold.
 *   2. Failed AFTER acceptance, inside the transaction — this call is the LAST
 *      statement in `upsertSessions`'s `withDb.tx`, so anything that throws or
 *      rolls back before it (a write conflict, an
 *      `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` timeout on a large batch) discards
 *      the stamp along with that slice. `stampIngestWatermarkAfterFailedBatch`
 *      exists for precisely this class: `upsertSessions` calls it from the
 *      failure path, outside the failed slice transaction, so a post-acceptance
 *      failure still records that the fleet reached us and any earlier slices
 *      committed.
 *   3. Failed before the route ever reached this service — a 5xx from an
 *      infrastructure fault, a broken route. Nothing server-side attributes
 *      those to a compute target, so no watermark can carry them; they are an
 *      API-level error-rate signal, not an ingestion-freshness one.
 *
 * Class 1 and class 3 are therefore genuine blind spots of the ingest-attempt
 * signal, not oversights: for those the org falls to QUIET at the same instant
 * it stops being ACTIVE. See `classifyOrgIngestionRow` in
 * `apps/api/app/cron/sample-session-ingestion-health/service.ts`, whose
 * docstring names the same three classes.
 *
 * SCOPE OF THE LANDED-DATA GUARD: it fires on the two batch shapes that persist
 * ZERO rows — an empty payload and an all-foreign-chunk payload.
 * `persistedSessionCount` is an upsert-call count, so a resync that re-posts
 * already-persisted sessions at their existing revision still upserts (an
 * equal-revision replay is not foreign) and still advances the watermark,
 * exactly as before — that shape is NOT a no-op batch here.
 *
 * COMPATIBILITY: an empty batch is NOT rejected at the ingest boundary. An older
 * Desktop posting an empty resync keeps succeeding with the same response
 * contract — it simply no longer refreshes a clock it had no evidence to
 * refresh, while still proving that it is attempting. Nothing on the wire
 * changes.
 */
export async function stampIngestSyncWatermark(
  tx: TransactionClient,
  input: {
    computeTargetId: string;
    persistedSessionCount: number;
    syncTimestamp: Date;
  }
): Promise<void> {
  const landed = input.persistedSessionCount > 0;

  await tx.computeTarget.updateMany({
    where: {
      id: input.computeTargetId,
      OR: [
        { lastAgentSessionSyncAttemptAt: null },
        { lastAgentSessionSyncAttemptAt: { lt: input.syncTimestamp } },
      ],
    },
    data: { lastAgentSessionSyncAttemptAt: input.syncTimestamp },
  });
  if (!landed) {
    return;
  }

  await tx.computeTarget.updateMany({
    where: {
      id: input.computeTargetId,
      OR: [
        { lastAgentSessionSyncAt: null },
        { lastAgentSessionSyncAt: { lt: input.syncTimestamp } },
      ],
    },
    data: { lastAgentSessionSyncAt: input.syncTimestamp },
  });
}

/**
 * ISS-4827 (review, PR #4256): stamp the watermark for a batch that was
 * ACCEPTED and then failed inside one of its per-session transactions — class 2
 * above.
 *
 * The in-transaction stamp cannot cover this: it is the last statement in the
 * `withDb.tx`, so an `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS` timeout or any
 * mid-transaction throw rolls it back with the data. Without this call the
 * attempt watermark ages in lockstep with the landed-data one, and a fleet whose
 * every batch times out crosses into QUIET at the same instant it stops being
 * ACTIVE — the classifier would read "nothing is even trying" for an outage in
 * which everything is trying. That is the coverage the heartbeat rule ISS-4827
 * replaced used to provide, restored here on POSITIVE attempt evidence instead
 * of on mere device presence.
 *
 * It runs OUTSIDE the failed transaction (its own `withDb`), so the stamp
 * survives the rollback. If no session rows landed, only the attempt watermark
 * is written. If earlier legacy multi-session slices committed, the landed-data
 * watermark moves too.
 *
 * BEST EFFORT, NEVER MASKING. The caller invokes this from the failure side of
 * a `finally`, so a throw here would replace the real ingest error with a
 * watermark-write error. It is caught and logged instead (a server-side log
 * wired to the existing API error monitoring, per the bad-data rule in
 * AGENTS.md); losing the stamp degrades to the non-paging QUIET side, which is
 * exactly where this org sat before this function existed.
 */
export async function stampIngestWatermarkAfterFailedBatch(input: {
  computeTargetId: string;
  persistedSessionCount: number;
  syncTimestamp: Date;
}): Promise<void> {
  try {
    await withDb((db) =>
      stampIngestSyncWatermark(db, {
        computeTargetId: input.computeTargetId,
        persistedSessionCount: input.persistedSessionCount,
        syncTimestamp: input.syncTimestamp,
      })
    );
  } catch (error) {
    log.error("Failed to stamp ingest watermark after a failed batch", {
      computeTargetId: input.computeTargetId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
