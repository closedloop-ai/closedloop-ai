import { DeliveryMatchOutcome } from "@repo/database";
import { FilterToken } from "@repo/observability/telemetry/filter-tokens";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { SegmentCompleteness } from "@repo/pensero/delivery-client";

// ---------------------------------------------------------------------------
// pensero.backfill.* metric emitter module (ISS-8761)
//
// Single import point for the scheduled delivery-points backfill's
// observability, following the emitSessionIngestion* / emitDataInvariant*
// pattern: one payload `type` per metric so the shape is enforced at compile
// time, and one thin wrapper each delegating to `emitTelemetryMetric` so the
// `_telemetryMetric: true` marker contract lives in exactly one place.
//
// WHY THIS FAMILY EXISTS. `runPenseroDeliveryBackfill` shipped with zero
// production callers: an org could enter a Pensero credential, watch the
// settings card confirm it, and never receive a single delivery point. Adding a
// cron fixes the missing trigger; it does NOT fix the missing signal. A
// scheduler whose fetches all 401 looks, from every screen in the product,
// exactly like the no-scheduler state it replaced. These metrics are what makes
// the difference visible.
//
// Emitting these does NOT create a queryable Datadog metric on its own: each
// needs a paired `datadog_logs_metric` generator plus a `datadog_monitor` in
// `example-org/infrastructure` (PRD-159). See packages/observability/README.md.
// ---------------------------------------------------------------------------

export const PenseroBackfillDegradedReason = {
  TruncationSignalled: "truncation_signalled",
  PlanTruncated: "plan_truncated",
  ContinuationPending: "continuation_pending",
  /**
   * The run's wall-clock budget stopped the sweep before this organization was
   * reached, or before its planned days were exhausted (codex + whitlockk, #6492).
   *
   * Emitted PER DEFERRED ORGANIZATION rather than once per run, so the signal
   * names WHICH tenant is being starved. One occurrence is the budget doing its
   * job; the same organization appearing run after run is a schedule too sparse
   * for the tenant count, and only a per-org series can tell those apart.
   */
  SweepBudgetExhausted: "sweep_budget_exhausted",
} as const;
export type PenseroBackfillDegradedReason =
  (typeof PenseroBackfillDegradedReason)[keyof typeof PenseroBackfillDegradedReason];

/**
 * The per-outcome tallies one run produced.
 *
 * FIVE SEPARATE FIELDS, never a single "unmatched" number. "we have no such
 * pull request", "we could not arbitrate between two", "this row can never have
 * one", and "the feed has not supplied one yet" are four different problems
 * with four different fixes, and a sum of them is a figure nobody can act on.
 * This mirrors `DeliveryBackfillReport.outcomeCounts`, which keeps them apart
 * for the same reason.
 */
export type PenseroBackfillOutcomeCounts = Record<DeliveryMatchOutcome, number>;

// `value:` (gauge), NOT `count:`. Days attempted is the state of one run, not
// an additive event stream — packages/observability/README.md is explicit that
// a gauge emitted under `count:` gets summed across the window.
type PenseroBackfillRunMetric = {
  metric: typeof FilterToken.PenseroBackfillRun;
  orgId: string;
  /** Days this run asked the provider for. */
  value: number;
  daysSucceeded: number;
  daysFailed: number;
  rowsWritten: number;
  artifactAssociationsWritten: number;
  peopleUnbridged: number;
  matched: number;
  noCounterpart: number;
  ambiguous: number;
  unmatchable: number;
  pendingReference: number;
};

// `count` is an ADDITIVE counter: a monitor pages on `sum(count)` over a short
// window, so one failing day per run for a week is a rising signal rather than
// a flat "1".
type PenseroBackfillDayFailedMetric = {
  metric: typeof FilterToken.PenseroBackfillDayFailed;
  orgId: string;
  day: string;
  count: number;
};

type PenseroBackfillDegradedMetric = {
  metric: typeof FilterToken.PenseroBackfillDegraded;
  orgId: string;
  reason: PenseroBackfillDegradedReason;
  count: number;
};

/** What one organization's run did. Emitted once per org per run. */
export function emitPenseroBackfillRun(sample: {
  orgId: string;
  daysAttempted: number;
  daysSucceeded: number;
  daysFailed: number;
  rowsWritten: number;
  artifactAssociationsWritten: number;
  peopleUnbridged: number;
  outcomeCounts: PenseroBackfillOutcomeCounts;
}): void {
  emitTelemetryMetric<PenseroBackfillRunMetric>({
    metric: FilterToken.PenseroBackfillRun,
    orgId: sample.orgId,
    value: sample.daysAttempted,
    daysSucceeded: sample.daysSucceeded,
    daysFailed: sample.daysFailed,
    rowsWritten: sample.rowsWritten,
    artifactAssociationsWritten: sample.artifactAssociationsWritten,
    peopleUnbridged: sample.peopleUnbridged,
    matched: sample.outcomeCounts[DeliveryMatchOutcome.MATCHED],
    noCounterpart: sample.outcomeCounts[DeliveryMatchOutcome.NO_COUNTERPART],
    ambiguous: sample.outcomeCounts[DeliveryMatchOutcome.AMBIGUOUS],
    unmatchable: sample.outcomeCounts[DeliveryMatchOutcome.UNMATCHABLE],
    pendingReference:
      sample.outcomeCounts[DeliveryMatchOutcome.PENDING_REFERENCE],
  });
}

/**
 * One day that could not be fetched. Counter — alarm on the sum over a window.
 *
 * The day is carried as a FIELD so an operator can see which window is missing
 * without re-deriving it from the ledger. It is not a metric tag: one row per
 * calendar day would be unbounded cardinality on a backward walk that never
 * stops.
 */
export function emitPenseroBackfillDayFailed(sample: {
  orgId: string;
  day: string;
}): void {
  emitTelemetryMetric<PenseroBackfillDayFailedMetric>({
    metric: FilterToken.PenseroBackfillDayFailed,
    orgId: sample.orgId,
    day: sample.day,
    count: 1,
  });
}

/** One degraded outcome. Counter — see the reason split above. */
export function emitPenseroBackfillDegraded(sample: {
  orgId: string;
  reason: PenseroBackfillDegradedReason;
}): void {
  emitTelemetryMetric<PenseroBackfillDegradedMetric>({
    metric: FilterToken.PenseroBackfillDegraded,
    orgId: sample.orgId,
    reason: sample.reason,
    count: 1,
  });
}

/**
 * The degraded reason a segment completeness implies, or null when it implies
 * none.
 *
 * A separate function rather than an inline check at the emit site so the ONE
 * mapping from `SegmentCompleteness` to an alertable reason lives in one place;
 * `Unverified` is the honest ceiling for every successful fetch and is
 * deliberately not degraded — alerting on it would fire on every run forever
 * and teach an operator to ignore the family.
 */
export function degradedReasonForCompleteness(
  completeness: SegmentCompleteness
): PenseroBackfillDegradedReason | null {
  return completeness === SegmentCompleteness.TruncationSignalled
    ? PenseroBackfillDegradedReason.TruncationSignalled
    : null;
}
