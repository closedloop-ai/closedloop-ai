/**
 * @file analytics-recompute.ts
 * @description Re-derivation of the `session_analytics` rollups (and their
 * FEA-2273 activity-metrics rows) for an explicit set of session ids, extracted
 * from sqlite.ts (ISS-5064) to shrink that grandfathered file.
 *
 * This is NOT boot-only work, which is why it is its own module rather than part
 * of ./boot-maintenance.js: `recomputeAnalyticsRollupsFor` backs BOTH the
 * exposed `recomputeAnalyticsRollups` surface method (used by the data-revision
 * rebuild) and the FEA-3743 stored-timestamp heal, whose `sessions.started_at`
 * rewrite must propagate into the persisted `session_analytics.started_at` copy.
 *
 * Pure LEAF: imports only leaf modules (the rollup primitives + metadata-budget
 * chunking from ./session-analytics-rollup.js, the metrics rollup from
 * ./activity-metrics.js), never sqlite.js — so sqlite.ts imports FROM here
 * one-directionally and there is no cycle. {@link AnalyticsRollupRecomputeResult}
 * moves with the function that produces it.
 */
import { upsertActivityMetricsRollupBatch } from "./activity-metrics.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  chunkSessionIdsByMetadataBudget,
  SESSION_ANALYTICS_BACKFILL_CHUNK,
  SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
  upsertSessionAnalyticsRollupBatch,
} from "./session-analytics-rollup.js";

/**
 * FEA-3597: the real per-chunk outcome of an analytics-rollup recompute.
 *
 * `recomputeAnalyticsRollupsFor` catches per-chunk failures and continues (by
 * design — it must not abandon the remaining chunks), so before this type its
 * callers could not tell a full repair from a total failure. That mattered
 * because the data-revision rebuild GATES a `data_revision` stamp on the
 * answer: stamping a session whose rollup never rebuilt seals it at the current
 * revision with stale derived rows, and nothing selects it again.
 *
 * ISS-5071 (@wongk): the recompute performs TWO writes per chunk — the PRIMARY
 * `session_analytics` transaction, then a separate best-effort activity-metrics
 * transaction — and a single number cannot answer both questions its callers
 * ask. So the outcome is reported on two independent axes:
 *
 * - `committed` — sessions whose PRIMARY `session_analytics` transaction
 *   committed. This is the "did rows on disk actually change" signal, and it is
 *   what cache invalidation / `desktop:db:changed` must read: a metrics-only
 *   failure still leaves freshly rewritten analytics rows that every mounted
 *   Insights query is now stale against.
 * - `failed` — sessions NOT fully repaired, counting a primary failure AND a
 *   metrics-only failure. This is the stamp gate: `failed > 0` means the batch
 *   is not fully repaired, so leave those sessions retryable.
 *
 * The two axes overlap on purpose — a metrics-only failure counts in BOTH — so
 * `committed + failed` may exceed `attempted`. Never derive one from the other
 * (`attempted - failed` is NOT the committed count; that arithmetic is exactly
 * the bug this split fixes).
 *
 * ISS-6165: `failed` is a COUNT, and the data-revision stamp gate that consumes
 * it could only act on it cohort-wide — one failing chunk withheld the stamp
 * from every session in the pass, including the ones that fully repaired. With a
 * 440-session missing-source population that is not a slow success but a
 * permanent one: the next pass re-selects the same cohort, the same chunk fails,
 * and nothing is ever retired. `failedSessionIds` names WHICH sessions are not
 * repaired so the gate can withhold exactly those and let the rest converge.
 */
export type AnalyticsRollupRecomputeResult = {
  attempted: number;
  committed: number;
  failed: number;
  /**
   * ISS-6165 — the ids counted by `failed`, so a caller gating a durable stamp
   * can withhold per session instead of per pass. Always the same length as
   * `failed`. Optional on the TYPE because this result crosses the db-host
   * `utilityProcess` proxy boundary and an older host build (or a test double
   * written against the pre-ISS-6165 shape) reports only the counts; a consumer
   * that cannot see the ids must fall back to the conservative cohort-wide
   * withholding rather than assume nothing failed.
   */
  failedSessionIds?: readonly string[];
};

/**
 * FEA-2273: refresh the activity-metrics rollup for a just-recomputed chunk of
 * sessions, in a SEPARATE best-effort transaction. `recomputeAnalyticsRollups`
 * rewrites `session_analytics` cohort inputs (human/agent turns → autonomy band,
 * runtimeMs → length band, harness) WITHOUT bumping `session_activity_segments.
 * version`, so the version-gated boot backfill (`backfillActivityMetrics`) would
 * never re-select these sessions and their cohort keys would go permanently
 * stale. Refreshing here closes that gap.
 *
 * ISS-5071: this REPORTS its outcome instead of swallowing it. It stays
 * best-effort in the sense that matters — a metrics failure never rolls back
 * the (already committed) analytics recompute — but the caller must be able to
 * see it, because the data-revision rebuild gates its `data_revision` stamp on
 * `failed` and a silent failure got a session SEALED with stale cohort keys.
 *
 * The old docstring claimed "the boot backfill remains the safety net on the
 * next open". It is not: `backfillActivityMetrics` selects
 * `WHERE sam.session_id IS NULL OR sam.version < seg.version`, and this
 * recompute deliberately does not bump `session_activity_segments.version`, so
 * an existing metrics row at the same version is never re-selected. Withholding
 * the stamp is the heal path — the session stays retryable.
 *
 * @returns true when the metrics rollup committed; false when it failed (logged).
 */
async function refreshMetricsAfterRecompute(
  prisma: DesktopPrisma,
  chunk: string[],
  now: string,
  log: (message: string) => void
): Promise<boolean> {
  try {
    await prisma.write((client) =>
      client.$transaction((tx) =>
        upsertActivityMetricsRollupBatch(tx, chunk, now)
      )
    );
    return true;
  } catch (error) {
    log(
      `recomputeAnalyticsRollups metrics refresh failed for ${chunk.length} session(s): ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

/**
 * Re-derive the `session_analytics` rollups (and their FEA-2273 activity-metrics
 * rows) for `sessionIds` from the current source rows. Shared by the exposed
 * `recomputeAnalyticsRollups` method and the FEA-3743 timestamp heal (whose
 * `sessions.started_at` rewrite must propagate into the persisted, sync-emitted
 * `session_analytics.started_at` copy — the analytics backfill only anti-joins
 * MISSING rows and so would leave an already-derived offset-form copy stale).
 *
 * Memory-bounded like `backfillSessionAnalytics`: `upsertSessionAnalyticsRollupBatch`
 * runs a `json_each` scan over every message of every session in the batch, so
 * chunks are budgeted by summed metadata bytes (secondary count bound =
 * SESSION_ANALYTICS_BACKFILL_CHUNK) — a single oversized session forms its own
 * chunk. The loop commits + releases between chunks; a per-chunk try/catch
 * isolates a heavy chunk.
 */
export async function recomputeAnalyticsRollupsFor(
  prisma: DesktopPrisma,
  sessionIds: string[],
  now: () => string,
  log: (message: string) => void
): Promise<AnalyticsRollupRecomputeResult> {
  if (sessionIds.length === 0) {
    return { attempted: 0, committed: 0, failed: 0, failedSessionIds: [] };
  }
  const chunks = await chunkSessionIdsByMetadataBudget(
    prisma,
    sessionIds,
    SESSION_ANALYTICS_ROLLUP_METADATA_BUDGET_BYTES,
    SESSION_ANALYTICS_BACKFILL_CHUNK
  );
  let offset = 0;
  // FEA-3597: count real per-chunk outcomes. This used to swallow every chunk
  // failure, so callers could never distinguish "repaired" from "logged and
  // moved on" — and the data-revision rebuild GATES a `data_revision` stamp on
  // that answer. A chunk that throws must make the caller withhold the stamp so
  // the session stays retryable, instead of being sealed with un-rebuilt rows.
  let failed = 0;
  // ISS-5071 (@wongk): the PRIMARY analytics outcome, tracked independently of
  // `failed`. A chunk whose `session_analytics` transaction committed has
  // rewritten rows on disk even if the SECONDARY metrics transaction below then
  // failed, so callers that invalidate caches / emit `desktop:db:changed` must
  // read this — not `attempted - failed`, which reports a metrics-only failure
  // as "nothing committed" and leaves mounted Insights queries stale.
  let committed = 0;
  // ISS-6165: the ids behind `failed`, accumulated on the SAME branches that
  // increment it, so the two can never disagree about which sessions are not
  // repaired.
  const failedSessionIds: string[] = [];
  for (const chunk of chunks) {
    try {
      await prisma.write((client) =>
        client.$transaction((tx) =>
          upsertSessionAnalyticsRollupBatch(tx, chunk, now(), { log })
        )
      );
      committed += chunk.length;
      // FEA-2273: the recompute changed these sessions' cohort inputs without
      // bumping segment version, so refresh their metrics rows here (the boot
      // backfill's version gate would otherwise never re-derive them).
      // ISS-5071: a metrics failure counts into `failed` so the data-revision
      // caller withholds the stamp. It still never rolls back the analytics
      // rollup above — that transaction has already committed (hence the
      // `committed` bump above it, which stands), only the STAMP is withheld,
      // which is what keeps the session retryable.
      if (!(await refreshMetricsAfterRecompute(prisma, chunk, now(), log))) {
        failed += chunk.length;
        failedSessionIds.push(...chunk);
      }
    } catch (error) {
      failed += chunk.length;
      failedSessionIds.push(...chunk);
      log(
        `recomputeAnalyticsRollups failed for chunk [${offset}, ${offset + chunk.length}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    offset += chunk.length;
  }
  // Deliberately RETURN the outcome rather than rethrowing: the two FEA-3743
  // heal callers invoke this as `.catch()`-isolated statements and a throw here
  // would change their behaviour.
  return { attempted: sessionIds.length, committed, failed, failedSessionIds };
}
