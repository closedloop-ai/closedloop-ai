// ISS-5809 — the PRIOR-PERIOD half of the Sessions usage summary.
//
// The Sessions summary cards show a period-over-period chip. Until ISS-5809 the
// web page produced it by issuing a SECOND `GET /agent-sessions/usage` for the
// prior window and subtracting in the browser — which re-ran the entire summary
// (every facet groupBy, the attribution keyset pager, the project-facet reads, the
// owner map, the compute-target read and the delivery pager) to obtain six
// scalars, five of which are computed here in three queries.
//
// What this module reads, and nothing else:
//   1. the core `sessionDetail.aggregate` — session count + input/output tokens
//   2. the `sourceLoopId`/`billingMode` cost snapshot, read AND classified by the
//      SHARED `computeSessionCostSplit` so the prior cost basis is derived by the
//      same rule as the current one (a second, drifting copy of either the query
//      shape or the classification is what the shared reader exists to prevent)
//   3. whatever `buildUsageSummaryWhereParts` itself needs to resolve the cohort
//
// The sixth figure — the prior `mergedPrCount` — is NOT read here. It costs zero
// additional DB work because the delivery scope is date-window-stripped and
// therefore identical for both periods, so `delivery-metrics.ts` collects the
// merged-PR set once and evaluates it against two windows. See
// `computeDeliverySummaryMetricsWithPrior`.
//
// COST-SENSITIVE QUERIES (deviation from PLN-1683 M1.2, recorded deliberately).
// The plan instructed reusing the CURRENT period's resolved cost-matched session
// ids for the prior read rather than re-running the candidate scan. That would be
// incorrect: `resolveCostBucketMatchedSessionIds` scans a candidate set already
// bounded by the current window's `lastActivityAt` predicate, so those ids ARE the
// current period's population. Scoping the prior aggregates to them would compare
// the current window against itself, filtered — a fabricated movement, and exactly
// the class of like-for-like violation the comparison contract exists to prevent.
// A cost-bucket-filtered query therefore resolves its own prior cohort. That is
// strictly no worse than the two-request status quo (which resolved two cohorts
// anyway) and the common, non-cost-sensitive path resolves none at all.

import { pctDelta } from "@closedloop-ai/loops-api/insights";
import type {
  AgentSessionUsageComparison,
  AgentSessionUsageComparisonDeltas,
} from "@repo/api/src/types/agent-session-usage-comparison";
import { AgentSessionComparisonMetric } from "@repo/api/src/types/agent-session-usage-comparison";
import { withDb } from "@repo/database";
import { toNumber } from "@/lib/prisma-number";
import type { SessionUsageInput } from "./records";
import { computeSessionCostSplit } from "./usage-cost-split";
import { buildUsageSummaryWhereParts } from "./usage-summary-where";

/** ISO bounds of a usage window. */
export type UsageComparisonWindow = {
  startDate: string;
  endDate: string;
};

/**
 * The current-period figures the comparison grades against — supplied by the
 * caller, which has already computed them, so this module never re-reads them.
 */
export type UsageComparisonCurrentFigures = {
  totalSessions: number;
  totalTokens: number;
  meteredEstimatedCost: number;
  apiEstimatedCost: number;
  mergedPrCount: number | null;
};

/**
 * The same slice of the period immediately before `[startDate, endDate]` — one
 * full period earlier, cut to the span the current window has actually ELAPSED.
 * Null when there is nothing honest to compare against.
 *
 * This is the server-side owner of the rule ISS-5315 previously kept in the client
 * (`sessionPriorWindow`). Deriving it from the BOUNDS alone — rather than from the
 * client's named range — is what lets the rule survive the current window changing
 * width or end, which is precisely what ISS-5809's window fix does to it.
 *
 * Two properties, and the review of ISS-5809 caught this function missing each in
 * turn. Both matter, and only holding both makes the percentage honest:
 *
 *  1. **Equal elapsed span.** The current window now ends with TODAY, so its
 *     population can only run up to `now`. A full-WIDTH prior window therefore
 *     graded a partial period against a complete one: on a 7d range at 01:00 UTC a
 *     perfectly steady org read ≈ -14% on every card, and because Cost is graded
 *     lower-is-better that surfaced as a GREEN "spend down 14%" chip describing
 *     nothing but the time of day.
 *  2. **Same phase.** Equal span is still not enough if the span sits at a
 *     different offset within the period. Pinning the prior window's END to the
 *     current window's start and sliding its START forward by the un-elapsed
 *     remainder — the first fix — shifted the whole comparison later in the day:
 *     at Aug 10 06:00 a current slice of Aug 4 00:00→Aug 10 06:00 was graded
 *     against Jul 28 18:00→Aug 3 23:59, so the prior side lost a Monday morning
 *     and gained a Sunday night. Activity is strongly diurnal and weekly, so
 *     ordinary weekday and time-of-day shape became WoW movement.
 *
 * The prior window therefore keeps the NOMINAL start (one full period back, same
 * phase) and truncates its END by the elapsed offset: Jul 28 00:00→Aug 3 06:00 for
 * that example. The two windows are consequently NOT adjacent while the current
 * period is still running — the un-elapsed tail of the prior period is deliberately
 * excluded, which is what "period-to-date vs. same period-to-date" means. A window
 * already fully in the past (`endDate <= now`) is unaffected: its elapsed span IS
 * its width, so the prior window is the full adjacent period exactly as before.
 *
 * Returns null rather than a window when: either bound is absent or unparseable,
 * the bounds are inverted, the window has not opened yet (nothing elapsed to
 * compare), or a derived prior bound falls outside the range a `Date` can
 * represent. That last case is reachable from the wire: `isoDateQuerySchema`
 * accepts any finite `Date.parse`, including ECMA-262 extended years, so a
 * `startDate` near the -271821 floor would otherwise throw `RangeError` out of
 * `toISOString` and surface as a generic 500 labeled "Authentication failed".
 * Every one of these degrades to "no comparison", as the contract promises.
 */
export function resolvePriorUsageWindow(
  startDate: string | undefined,
  endDate: string | undefined,
  now: Date = new Date()
): UsageComparisonWindow | null {
  if (!(startDate && endDate)) {
    return null;
  }
  const startMs = Date.parse(startDate);
  const endMs = Date.parse(endDate);
  if (!(Number.isFinite(startMs) && Number.isFinite(endMs))) {
    return null;
  }
  if (endMs < startMs) {
    return null;
  }
  const nowMs = now.getTime();
  const elapsedEndMs = Number.isFinite(nowMs) ? Math.min(endMs, nowMs) : endMs;
  if (elapsedEndMs < startMs) {
    return null;
  }
  // Nominal start — one full period back, so the prior slice sits at the same
  // phase (weekday, hour) as the current one. The END is what moves.
  const priorStartMs = startMs - (endMs - startMs + 1);
  const priorEndMs = priorStartMs + (elapsedEndMs - startMs);
  if (
    !(isRepresentableEpoch(priorEndMs) && isRepresentableEpoch(priorStartMs))
  ) {
    return null;
  }
  return {
    endDate: new Date(priorEndMs).toISOString(),
    startDate: new Date(priorStartMs).toISOString(),
  };
}

/** `input` re-windowed onto `window`, every other filter preserved. */
export function withUsageWindow(
  input: SessionUsageInput,
  window: UsageComparisonWindow
): SessionUsageInput {
  return {
    ...input,
    filters: {
      ...input.filters,
      startDate: window.startDate,
      endDate: window.endDate,
    },
  };
}

/**
 * Reads the prior window's comparable figures and returns the percent movement
 * for each card that has an honest one.
 *
 * `priorMergedPrCount` comes from the delivery pass (one merged-PR collection,
 * two windows), so this issues no delivery read of its own.
 */
export async function computeUsageComparison({
  input,
  priorWindow,
  current,
  priorMergedPrCount,
}: {
  input: SessionUsageInput;
  priorWindow: UsageComparisonWindow;
  current: UsageComparisonCurrentFigures;
  priorMergedPrCount: number | null;
}): Promise<AgentSessionUsageComparison> {
  const priorInput = withUsageWindow(input, priorWindow);
  const { where } = await buildUsageSummaryWhereParts(priorInput);
  const [aggregate, priorCostSplit] = await Promise.all([
    withDb((db) =>
      db.sessionDetail.aggregate({
        where,
        _count: { _all: true },
        _sum: {
          inputTokens: true,
          outputTokens: true,
        },
      })
    ),
    // Through the SHARED reader, never a second copy of its groupBy shape: the
    // knowledge of what the classifier needs (grouped by sourceLoopId+billingMode,
    // summing estimatedCost) lives in `usage-cost-split` alone, so a change to it
    // cannot leave this module reading the current period's cost by one rule and
    // the prior period's by another. The delivery denominator reads it the same way.
    computeSessionCostSplit(input.organizationId, where),
  ]);
  const priorTokens =
    toNumber(aggregate._sum.inputTokens) +
    toNumber(aggregate._sum.outputTokens);

  const deltas: AgentSessionUsageComparisonDeltas = {};
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.Sessions,
    current.totalSessions,
    aggregate._count._all
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.Tokens,
    current.totalTokens,
    priorTokens
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.MeteredCost,
    current.meteredEstimatedCost,
    priorCostSplit.meteredEstimatedCost
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.ApiCost,
    current.apiEstimatedCost,
    priorCostSplit.apiEstimatedCost
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.PrsShipped,
    current.mergedPrCount,
    priorMergedPrCount
  );

  return {
    priorStartDate: priorWindow.startDate,
    priorEndDate: priorWindow.endDate,
    deltas,
  };
}

/**
 * Writes one metric's movement, or nothing at all.
 *
 * A nullable figure absent on EITHER side yields no entry: an absent count is "we
 * do not know", never a zero to divide by or to be divided into. `pctDelta` then
 * declines a baseline too near zero and a magnitude past the display ceiling on
 * its own. One helper rather than one per metric, so a nullable metric added later
 * cannot arrive with a subtly different idea of what counts as a usable baseline.
 */
function assignDelta(
  deltas: AgentSessionUsageComparisonDeltas,
  metric: AgentSessionComparisonMetric,
  current: number | null,
  prior: number | null
): void {
  if (typeof current !== "number" || typeof prior !== "number") {
    return;
  }
  if (!(Number.isFinite(current) && Number.isFinite(prior))) {
    return;
  }
  const delta = pctDelta(current, prior);
  if (delta === null) {
    return;
  }
  deltas[metric] = delta;
}

/** Whether `epochMs` is inside the range a JS `Date` can represent. */
function isRepresentableEpoch(epochMs: number): boolean {
  return Number.isFinite(epochMs) && Math.abs(epochMs) <= MAX_EPOCH_MS;
}

/** ECMA-262's time-value limit: ±100,000,000 days from the epoch. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;
