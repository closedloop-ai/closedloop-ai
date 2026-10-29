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
//   1. the core `sessionDetail.aggregate` — session count + all four token
//      counters (input, output, cache read, cache write; ISS-7175)
//   2. the `legacyLoopCostLedger`/`billingMode` cost snapshot, read AND classified by the
//      SHARED `computeSessionCostSplit` so the prior cost basis is derived by the
//      same rule as the current one (a second, drifting copy of either the query
//      shape or the classification is what the shared reader exists to prevent)
//   3. whatever `buildUsageSummaryWhere` itself needs to resolve the cohort
//
// The sixth figure — the prior `mergedPrCount` — is NOT read here. It costs zero
// additional DB work because the delivery scope is date-window-stripped and
// therefore identical for both periods, so `delivery-metrics.ts` collects the
// merged-PR set once and evaluates it against two windows. See
// `foldDeliverySummaryMetricsWithPrior`.
//
// A COST-BUCKET FILTER NEEDS NOTHING SPECIAL HERE. The whole-session cost is
// `session_detail.estimated_cost`, so a bucket is an ordinary `where` conjunct
// that composes for the prior window exactly like every other facet.

import { pctDelta } from "@closedloop-ai/loops-api/insights";
import type {
  AgentSessionUsageComparison,
  AgentSessionUsageComparisonDeltas,
} from "@repo/api/src/types/agent-session-usage-comparison";
import { AgentSessionComparisonMetric } from "@repo/api/src/types/agent-session-usage-comparison";
import { sumSessionTokenCounters } from "@repo/api/src/utils/session-token-total";
import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import {
  EmissionRollupCause,
  FixedWindowEmissionThrottle,
} from "@/lib/observability/fixed-window-emission-throttle";
import { toNumber } from "@/lib/prisma-number";
import { toViewerScope } from "./project-resolution";
import type { SessionUsageInput } from "./records";
import {
  SESSIONS_USAGE_COMPARISON_LATENCY_BUDGET_MS,
  SESSIONS_USAGE_COMPARISON_LATENCY_METRIC,
} from "./session-read-metrics";
import { computeSessionCostSplit } from "./usage-cost-split";
import { buildUsageSummaryWhere } from "./usage-summary-where";

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
  /** ISS-4748 — the subscription-INCLUSIVE grand total this period. */
  totalEstimatedCost: number;
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
 * The prior window's own comparable figures — everything the comparison needs
 * from the database, and nothing it needs from the current period.
 *
 * ISS-7422: this type exists so the read can be SEPARATED from the arithmetic.
 * The prior read depends on the request's filters alone, but it used to run as a
 * fourth serial stage after the current aggregates, the cost split and the
 * delivery pager had all settled — so its round trips were added to the request
 * rather than overlapped with it, on exactly the endpoint the reporter called
 * slow. Splitting it lets `buildUsageSummary` start it alongside the other
 * independent reads and finish with the pure fold below.
 */
export type PriorUsageFigures = {
  totalSessions: number;
  totalTokens: number;
  meteredEstimatedCost: number;
  apiEstimatedCost: number;
  /** ISS-4748 — the subscription-INCLUSIVE grand total for the prior window. */
  totalEstimatedCost: number;
};

/**
 * Reads the prior window's comparable figures.
 *
 * The prior `mergedPrCount` is deliberately not among them: it costs zero
 * additional DB work (see this module's header) and reaches the fold from the
 * delivery pass instead.
 */
export async function readPriorUsageFigures({
  input,
  priorWindow,
}: {
  input: SessionUsageInput;
  priorWindow: UsageComparisonWindow;
}): Promise<PriorUsageFigures> {
  const startedAtMs = Date.now();
  const priorInput = withUsageWindow(input, priorWindow);
  const where = await buildUsageSummaryWhere(priorInput);
  const [aggregate, priorCostSplit] = await Promise.all([
    withDb((db) =>
      db.sessionDetail.aggregate({
        where,
        _count: { _all: true },
        // ISS-7175: the cache columns are SELECTED, not just summed below. The
        // tile's basis moved to all four counters, and reading only the uncached
        // pair here would leave every cache token out of the baseline alone —
        // `_sum.cacheReadTokens` would be undefined, `toNumber` would floor it to
        // 0, and the chip would report a huge fabricated rise on a flat period.
        _sum: {
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
        },
      })
    ),
    // Through the SHARED reader, never a second copy of its groupBy shape: the
    // knowledge of what the classifier needs (grouped by legacyLoopCostLedger+billingMode,
    // summing estimatedCost) lives in `usage-cost-split` alone, so a change to it
    // cannot leave this module reading the current period's cost by one rule and
    // the prior period's by another. The delivery denominator reads it the same way.
    computeSessionCostSplit(where),
  ]);
  const priorTokens = sumSessionTokenCounters({
    input: toNumber(aggregate._sum.inputTokens),
    output: toNumber(aggregate._sum.outputTokens),
    cacheRead: toNumber(aggregate._sum.cacheReadTokens),
    cacheWrite: toNumber(aggregate._sum.cacheWriteTokens),
  });

  reportComparisonLatency(
    {
      organizationId: input.organizationId,
      viewerScope: toViewerScope(input.filters),
    },
    Date.now() - startedAtMs
  );

  return {
    totalSessions: aggregate._count._all,
    totalTokens: priorTokens,
    meteredEstimatedCost: priorCostSplit.meteredEstimatedCost,
    apiEstimatedCost: priorCostSplit.apiEstimatedCost,
    // Read from the split, never re-summed here — `SessionCostSplit` owns this
    // total, summed once over all three ledgers. Costs no extra query: the
    // split is already read above.
    totalEstimatedCost: priorCostSplit.totalEstimatedCost,
  };
}

/**
 * The percent movement for each card that has an honest one — pure arithmetic
 * over two already-read periods, so it can run after the current figures land
 * without holding a database round trip open behind them.
 */
export function foldUsageComparison({
  priorWindow,
  current,
  prior,
  priorMergedPrCount,
}: {
  priorWindow: UsageComparisonWindow;
  current: UsageComparisonCurrentFigures;
  prior: PriorUsageFigures;
  priorMergedPrCount: number | null;
}): AgentSessionUsageComparison {
  const deltas: AgentSessionUsageComparisonDeltas = {};
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.Sessions,
    current.totalSessions,
    prior.totalSessions
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.Tokens,
    current.totalTokens,
    prior.totalTokens
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.MeteredCost,
    current.meteredEstimatedCost,
    prior.meteredEstimatedCost
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.ApiCost,
    current.apiEstimatedCost,
    prior.apiEstimatedCost
  );
  assignDelta(
    deltas,
    AgentSessionComparisonMetric.TotalCost,
    current.totalEstimatedCost,
    prior.totalEstimatedCost
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

/** The principal one comparison-latency sample is attributed to. */
type ComparisonLatencyScope = {
  organizationId: string;
  viewerScope: string;
};

/**
 * WHY THIS IS THROTTLED (#5852 review).
 *
 * `GET /agent-sessions/usage?comparison=prior` is an ordinary authenticated read
 * that the dashboard itself polls, so every refresh — or a caller replaying the
 * route directly — drives one emission per request, without limit. That is the
 * amplification vector `apps/api/AGENTS.md` ("Emission and Abuse Control")
 * forbids: bound emission per org/reason at the choke point and keep a bounded
 * suppressed count. {@link FixedWindowEmissionThrottle} supplies both bounds —
 * one sample per (org, viewer scope) per window plus one aggregate rollup, and a
 * hard max-entry LRU cap on a keyspace derived from caller-reachable input.
 *
 * WHAT THIS COSTS THE METRIC, stated because it is not free. A latency sample
 * that is suppressed is GONE — the rollup carries how many reads it stood for,
 * never their durations, so `agent_sessions.dashboard.comparison_latency` is a
 * once-per-window-per-org SAMPLE of the distribution rather than a census of it.
 * That is enough for what AC5 asks (is the comparison breaching its budget, and
 * for whom) because a breach that only ever lands on suppressed reads would have
 * to miss every window's first read; it is NOT enough to compute an exact
 * request-weighted mean, and a monitor must not be written as if it were.
 *
 * Process-local and best-effort per serverless instance, and the suppressed
 * count is materialised by an event rather than a clock — see the throttle's own
 * module docstring. Exported so tests can reset it between cases; production
 * code must not reach into it.
 */
export const usageComparisonLatencyThrottle =
  new FixedWindowEmissionThrottle<ComparisonLatencyScope>({
    onFlush: (scope, suppressedCount, cause) =>
      emitComparisonLatencyRollup(scope, suppressedCount, cause),
  });

/**
 * The comparison's own latency, which the whole-read metric cannot isolate.
 * `budgetMs` rides every sample so the threshold is versioned beside the code
 * rather than only in the out-of-repo monitor.
 *
 * NEVER THROWS. A failure to REPORT the read's duration must not fail the read
 * that already succeeded — same guard, and the same reason, as
 * `reportStrippedTilings` in `activity-tiling-strip.ts`.
 */
function reportComparisonLatency(
  scope: ComparisonLatencyScope,
  durationMs: number
): void {
  try {
    const decision = usageComparisonLatencyThrottle.record(
      `${scope.organizationId}|${scope.viewerScope}`,
      scope,
      Date.now()
    );
    if (decision.flushedSuppressedCount > 0) {
      emitComparisonLatencyRollup(
        scope,
        decision.flushedSuppressedCount,
        EmissionRollupCause.Window
      );
    }
    if (decision.emit) {
      emitTelemetryMetric({
        metric: SESSIONS_USAGE_COMPARISON_LATENCY_METRIC,
        ...scope,
        value: durationMs,
        budgetMs: SESSIONS_USAGE_COMPARISON_LATENCY_BUDGET_MS,
      });
    }
  } catch (error) {
    log.warn("[agent-sessions] Failed to report comparison latency", {
      event: SESSIONS_USAGE_COMPARISON_LATENCY_METRIC,
      organizationId: scope.organizationId,
      error: parseError(error),
    });
  }
}

/**
 * The suppressed reads one closed window stood for. Deliberately carries NO
 * `value`: there is no single duration these reads shared, and publishing one
 * would put a fabricated latency on the same metric name the samples use.
 * `aggregated` is what lets a monitor exclude these rows from a latency
 * distribution while still summing `occurrences` for true request volume.
 */
function emitComparisonLatencyRollup(
  scope: ComparisonLatencyScope,
  occurrences: number,
  flushedBy: EmissionRollupCause
): void {
  emitTelemetryMetric({
    metric: SESSIONS_USAGE_COMPARISON_LATENCY_METRIC,
    ...scope,
    occurrences,
    aggregated: true,
    flushedBy,
  });
}
