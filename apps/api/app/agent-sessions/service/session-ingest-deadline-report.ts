/**
 * @file session-ingest-deadline-report.ts
 * @description ISS-8145 — the signal for a session that cannot fit its write
 * deadline at all, on the one path that previously emitted nothing.
 *
 * ISS-8186 bounded how much work ONE REQUEST attempts and reports the tail it
 * hands back (`IngestRuntimeBudgetDeferred`). That bound is per request; it
 * cannot help a session whose OWN slice outruns its transaction deadline,
 * because the mandatory first slice is deliberately exempt from the budget and
 * runs under the full `AGENT_SESSION_UPSERT_TX_TIMEOUT_MS`.
 *
 * What happens to such a session is the gap this closes. Its slice throws
 * P2028; if it was the only session attempted, `settleSliceFailures` rethrows
 * rather than reporting, the request answers `ingestion_failed`, and the
 * desktop re-sends the identical payload on the next tick — forever, since
 * nothing about the payload or the deadline changes. So the ONE shape that
 * cannot converge on its own was also the one shape that emitted no counter:
 * `SliceFailed` fires only for a PARTIAL batch, and a single-session batch is
 * never partial.
 *
 * Scope, stated plainly because the acceptance criterion asks for an alert:
 * `emitTelemetryMetric` writes a structured log, and turning that into an
 * alertable metric needs a Datadog log-metric generator that lives OUT of this
 * repo (see `session-sync-metrics.ts`'s header). This module puts the condition
 * on the monitored metric stream under a name of its own; arming a monitor on
 * that name is the remaining, out-of-repo half.
 *
 * That half is ISS-10077 ("Datadog: no log-metric generator for the
 * `agent_sessions.sync.*` family"), which covers this metric along with every
 * sibling in the family — named here rather than left as prose so the gap is a
 * tracked ticket a reader can follow, not a paragraph.
 */
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { getPrismaErrorCode } from "@/lib/db-utils";
import type { UpsertSessionsContext } from "./records";
import { boundSampledIdentifier } from "./sampled-identifier";
import { SessionSyncMetric } from "./session-sync-metrics";

/**
 * Prisma's interactive-transaction timeout: the slice outran the deadline it
 * was opened with, so nothing it wrote was committed.
 */
const TRANSACTION_TIMEOUT_ERROR_CODE = "P2028";

/** Whether this failure is "the session did not fit", not "the row is poison". */
export function isSliceDeadlineFailure(error: unknown): boolean {
  return getPrismaErrorCode(error) === TRANSACTION_TIMEOUT_ERROR_CODE;
}

/**
 * The legacy (`rowLevelAck` absent) path's reporter: that batch is
 * all-or-nothing, so its rethrow is the same non-convergence as the all-failed
 * exit in `settleSliceFailures` and nothing downstream reports it.
 *
 * The deadline TEST lives here rather than at the call site because the call
 * site is inside `upsertSessionsBatch`'s session loop, which sits at the
 * cognitive-complexity ceiling — a conditional there costs a budget the loop
 * does not have.
 */
export function reportLegacyBatchDeadlineFailure(
  context: UpsertSessionsContext,
  error: unknown,
  externalSessionId: string
): void {
  if (!isSliceDeadlineFailure(error)) {
    return;
  }
  reportSessionIngestDeadlineExceeded(context, [externalSessionId]);
}

/**
 * Report the sessions whose own write transaction could not fit its deadline.
 *
 * Emitted from the paths that would otherwise throw with no counter behind
 * them, and only when at least one failure is actually a deadline: counting
 * zero here would make the metric measure traffic rather than the condition,
 * the rule every sibling emission in this service keeps.
 *
 * The externalSessionId is carried because it is the only thing that makes the
 * condition actionable — a count alone cannot tell an operator WHICH session to
 * look at, and this is the layer that still knows.
 */
export function reportSessionIngestDeadlineExceeded(
  context: UpsertSessionsContext,
  externalSessionIds: readonly string[]
): void {
  if (externalSessionIds.length === 0) {
    return;
  }
  log.error("Desktop agent session exceeded its write deadline", {
    computeTargetId: context.computeTargetId,
    organizationId: context.organizationId,
    deadlineExceededSessionCount: externalSessionIds.length,
    // Both caps, not one (ISS-8781): the slice bounds HOW MANY ids the line
    // carries and nothing about their SIZE, and `externalSessionId` arrives
    // from the wire as `z.string().trim().min(1)` with no maximum. This path is
    // the one that repeats forever — the deadline is what makes the desktop
    // re-send the identical payload — so five multi-MiB ids would be written on
    // every retry.
    externalSessionIds: externalSessionIds
      .slice(0, DEADLINE_SESSION_LOG_SAMPLE)
      .map(boundSampledIdentifier),
  });
  emitTelemetryMetric({
    metric: SessionSyncMetric.IngestSessionDeadlineExceeded,
    organizationId: context.organizationId,
    computeTargetId: context.computeTargetId,
    count: externalSessionIds.length,
  });
}

/** A non-converging cohort is a handful of rows; past that, the count describes it. */
const DEADLINE_SESSION_LOG_SAMPLE = 5;
