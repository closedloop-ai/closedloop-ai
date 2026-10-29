// ISS-5809 — the Sessions usage-summary composition root.
//
// Extracted from `service.ts` so the summary read —
// which owns WHICH population each aggregate runs over, and now also the
// prior-period comparison — lives beside the modules it composes rather than
// inside the session service god-object. Same extraction `delivery-metrics.ts`
// already made out of this method.

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { sumSessionTokenCounters } from "@repo/api/src/utils/session-token-total";
import { type Prisma, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import type { LimitFunction } from "p-limit";
import {
  type AttributionLenses,
  aggregateSessionAttributionLenses,
} from "@/lib/agent-session-attribution";
import { readSessionAttributionBranchIds } from "@/lib/agent-session-attribution-read";
import { createDbFanoutLimiter } from "@/lib/db-fanout";
import { toNumber } from "@/lib/prisma-number";
import {
  collectDeliveryPrScope,
  foldDeliverySummaryMetricsWithPrior,
  toDeliverySummaryFields,
} from "./delivery-metrics";
import { buildSessionFacetCountWheres } from "./facet-count-where";
import { buildLastSyncTargetsQuery } from "./last-sync-targets";
import { resolveLocPerDollarCostBasis } from "./loc-per-dollar-basis";
import { foldLocPerDollarCoverage } from "./loc-per-dollar-coverage";
import { buildModelFilterOptions } from "./model-filter-options";
import type { SessionsPenseroPointsReader } from "./pensero-points-per-dollar";
import { buildProjectFacetOptions } from "./project-facet-options";
import { toLastSyncTarget, toViewerScope } from "./project-resolution";
import type { SessionUsageInput } from "./records";
import {
  SESSIONS_DASHBOARD_QUERY_LATENCY_METRIC,
  SESSIONS_LOC_PER_DOLLAR_COVERAGE_METRIC,
} from "./session-read-metrics";
import type {
  PriorUsageFigures,
  UsageComparisonWindow,
} from "./usage-comparison";
import {
  foldUsageComparison,
  readPriorUsageFigures,
  resolvePriorUsageWindow,
} from "./usage-comparison";
import { splitSessionCost } from "./usage-cost-split";
import {
  buildUsageByHarness,
  buildUsageByModel,
  buildUsageByRepository,
  buildUsageByUser,
} from "./usage-facet-projections";
import { readUsageGroupsByAssignee } from "./usage-owner-groups";
import { buildUsageOwnerMap } from "./usage-owner-lookup";
import { buildUsageSummaryWhere } from "./usage-summary-where";

export async function buildUsageSummary(
  input: SessionUsageInput,
  /**
   * ISS-11117: reads the matched sessions' Pensero points ratio.
   *
   * A parameter rather than a field on `input` on purpose: the TypedSQL shadow
   * comparison re-runs the builder with the SAME input, and a reader carried on
   * the input would make that comparison issue a second delivery read whose
   * result nothing renders. Absent — the shadow path, the desktop path, a
   * reader outside the Pensero rollout (ISS-11895), and every test that does
   * not care — means no Pensero numerator and no lens hydration on its account,
   * so the LOC/$ card renders exactly as today.
   */
  readPenseroPointsPerDollar?: SessionsPenseroPointsReader
): Promise<AgentSessionUsageSummary> {
  const startedAtMs = Date.now();
  // ISS-4429 / FEA-4298: window the summary on `lastActivityAt` — the SAME date field the
  // Sessions list uses (`findSessions`, dateField "lastActivityAt") — so the
  // summary cards aggregate the SAME population the table paints. Previously
  // this defaulted to `sessionStartedAt`, so a session that STARTED before the
  // window but was resumed/active inside it landed in the table yet fell out of
  // these totals, and the cards could read `totalSessions: 0` while the table
  // showed rows (the reported ISS-4429 divergence). This route serves ONLY the
  // Sessions summary bar (see `/agent-sessions/usage`), so aligning it here does
  // not affect the org Dashboard summary (its own `getDashboardSummary` keeps
  // `sessionStartedAt`, matching that surface's "started in period" semantics).
  // FEA-4293/4294 (thread whitlockk, table↔summary parity): a cost-bucket filter is
  // applied by the TABLE on the RECONCILED captured cost, not on the stored
  // `estimatedCost` rollup the `buildCostBucketWhere` DB predicate keys off. So
  // the summary must NOT restate that rollup predicate (it would drop a legacy
  // row stored at 0 whose priced events total, say, $0.42 — a row the table
  // shows under "≤ $1"). Instead resolve the SAME reconciled-matched id set the
  // table paints and scope every summary aggregate to it, so the cards and the
  // table agree by construction. Every OTHER facet stays in `where`.
  const where = await buildUsageSummaryWhere(input);
  // ISS-5283: the per-option FACET counts run under a `where` that applies
  // every OTHER active filter but excludes the facet's own dimension, so a
  // filtered facet still lists the options the user can widen to instead of
  // collapsing to the one already selected. The summary TOTALS below keep the
  // fully filtered `where` — they describe the current view. A dimension with
  // no active filter reuses `where` verbatim and issues no extra query, so an
  // unfiltered read is unchanged. See `facet-count-where.ts` for the full
  // rationale and the security scope this deliberately does not relax.
  const facetWheres = await buildSessionFacetCountWheres(input, where);
  // ISS-7598: ONE limiter shared by every read this stage issues, because
  // concurrency bounds compose by ADDITION, not by maximum — a limiter per
  // fan-out would let the three below stack to 3x. Measured before this change,
  // the stage peaked at 10 simultaneous pooled acquires (8 here, plus 1 from
  // each sibling) against a `DATABASE_URL` pool of 10, so one
  // `/agent-sessions/usage` request could take the whole pool and queue every
  // other caller behind it.
  //
  // Only the LEAF reads are wrapped; the members of the outer `Promise.all` are
  // deliberately not. A member borrows no connection of its own, so a slot spent
  // on one buys no bound — and because that member then awaits leaves submitted
  // to this same limiter, holding a slot across them would nest a queued task
  // inside a slot-holder and shrink the real budget.
  const limiter = createDbFanoutLimiter();
  // ISS-11204 asks for the lenses to be left out of the response; ISS-11117
  // needs the branch set `byBranch` keys whenever it has a numerator to read.
  // ISS-12284: an opted-out request reads only that set, never the lenses.
  const publishAttributionLenses =
    input.filters.attribution !== AgentSessionUsageAttribution.Omit;
  const [summaryRows, attribution, byProject, byUserGroup] = await Promise.all([
    withDb(async (db) =>
      Promise.all([
        limiter(() =>
          db.sessionDetail.aggregate({
            where,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
            _min: {
              sessionStartedAt: true,
            },
            _max: {
              sessionStartedAt: true,
            },
          })
        ),
        limiter(() =>
          db.agentSessionTokenUsage.groupBy({
            by: ["model"],
            where: {
              session: {
                is: where,
              },
            },
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          })
        ),
        limiter(() =>
          db.sessionDetail.groupBy({
            by: ["harness"],
            // ISS-5283: Harness facet counts exclude the Harness selection
            // itself — this is the facet in the operator's report.
            where: facetWheres.harness,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              cacheReadTokens: true,
              cacheWriteTokens: true,
              estimatedCost: true,
            },
          })
        ),
        limiter(() =>
          db.sessionDetail.groupBy({
            by: ["repositoryFullName"],
            // ISS-5283: Repository facet counts exclude the Repository selection.
            where: facetWheres.repository,
            _count: {
              _all: true,
            },
            _sum: {
              inputTokens: true,
              outputTokens: true,
              estimatedCost: true,
              errorCount: true,
            },
          })
        ),
        // Cost split. Aggregate estimatedCost in the DB grouped by both
        // legacyLoopCostLedger and billingMode, instead of materializing one row
        // per session and summing in JS. A former loop session keeps its stored
        // ledger (ISS-12435); every other row is classified by its synced
        // billingMode. Classification in `usage-cost-split`.
        limiter(() =>
          db.sessionDetail.groupBy({
            by: ["legacyLoopCostLedger", "billingMode"],
            where,
            _sum: {
              estimatedCost: true,
            },
          })
        ),
        // FEA-4303: Model filter facet options, grouped by the PRIMARY
        // displayed model (`SessionDetail.model`) — the exact string the
        // Sessions table paints in its Model column and the same field the
        // Model filter predicate matches. Sourced separately from `byModel`
        // (which spans every model a session used, including subagent models)
        // so the facet's options never offer a value the column can't show.
        limiter(() =>
          db.sessionDetail.groupBy({
            by: ["model"],
            // ISS-5283: Model facet counts exclude the Model selection itself.
            where: facetWheres.model,
            _count: {
              _all: true,
            },
          })
        ),
        // ISS-4828: the "Compute Target Freshness" card's population — page
        // width, select, and the presence-leads ordering live in the module.
        limiter(() =>
          db.computeTarget.findMany(buildLastSyncTargetsQuery(input))
        ),
      ])
    ),
    // ISS-11204: the listing uses summary totals and facets, not the optional
    // branch/PR attribution lenses. Avoid their corpus-wide hydration and wire
    // payload when the reader explicitly opts out. Existing clients retain
    // both lenses by default; no totals or facet populations change.
    //
    // ISS-11117: the Pensero numerator's branch population IS `byBranch`'s key
    // set, and the ONE client that sends `attribution=omit` is the Sessions
    // listing itself (`agent-sessions-data-source.ts` → `withUsageQuery`) — the
    // very surface the points card renders on. ISS-12284: so an opted-out
    // request with a reader reads that key set alone, one statement, instead of
    // hydrating the lenses it then withholds.
    readUsageAttribution({
      organizationId: input.organizationId,
      where,
      limiter,
      publishLenses: publishAttributionLenses,
      needsBranchIds: readPenseroPointsPerDollar !== undefined,
    }),
    buildProjectFacetOptions(
      input.organizationId,
      facetWheres.project,
      limiter
    ),
    // ISS-5283: Owner facet counts exclude the Owner selection itself.
    readUsageGroupsByAssignee(input.organizationId, facetWheres.owner, limiter),
  ]);
  const [
    aggregate,
    byModelGroup,
    byHarnessGroup,
    byRepositoryGroup,
    costsByLedger,
    primaryModelGroup,
    lastSyncTargets,
  ] = summaryRows;
  // ISS-5809: the prior comparison window, resolved from the CURRENT window's
  // bounds rather than from a client-named range, so the equal-width guarantee
  // survives the current window changing shape. Null unless the caller opted in
  // and the active range actually has a period before it.
  const priorWindow =
    input.filters.comparison === AgentSessionComparisonMode.Prior
      ? resolvePriorUsageWindow(input.filters.startDate, input.filters.endDate)
      : null;

  // ISS-7343: these three reads are mutually independent and used to run as a
  // four-deep sequential chain, so the delivery keyset pass and the Owner lookup
  // each waited on a cost split neither of them reads. The cost split reaches the
  // delivery metrics only as the LOC/$ DIVISOR, applied by the pure fold below —
  // see `foldDeliverySummaryMetricsWithPrior`. Measured on this endpoint's
  // production p75, server time is ~97% of the request and is dominated by
  // per-query round trips and connection acquisition, so removing a round trip
  // from the critical path is worth more than it costs in peak pool use.
  //
  // The three-way cost split is also the delivery LOC/$ source,
  // folded from the same windowed snapshot the summary cost card displays.
  //
  // ISS-7422: the PRIOR-PERIOD read joins that same stage. It depends on the
  // request's filters alone — never on the current period's figures, which reach
  // it through the pure fold below — yet it used to run as a FIFTH serial stage
  // after this one had settled, adding its round trips to the request instead of
  // overlapping them with the delivery pager. Its cohort resolution is
  // deliberately left inside this stage rather than hoisted above the current
  // aggregates: overlapping the two windows' `sessionDetail.aggregate` calls
  // would make their relative order an implementation detail, and this stage's
  // keyset delivery pass is the one worth hiding the prior read behind anyway.
  const [costSplit, deliveryScope, usersById, priorFigures] = await Promise.all(
    [
      splitSessionCost(costsByLedger),
      // FEA-3156 / FEA-4295 / ISS-4667: the merged-PR population behind the
      // delivery cards (PRs shipped, median PR size, merged LOC/$). The delivery
      // scope and the `mergedAt` merge-window bounding live behind this call.
      // ISS-7705: it also measures that scope's coverage against `where` — the
      // very predicate the divisor below is summed over — so the gate describes
      // the divisor this request actually published, not a re-derivation of it.
      // ISS-6136: the SAME limiter stage 1 used. Stage 1 is fully awaited above,
      // so reusing it costs nothing and keeps this stage on one call budget
      // rather than the three its subtree would otherwise open.
      collectDeliveryPrScope(input, where, priorWindow, limiter),
      buildUsageOwnerMap(input.organizationId, byUserGroup),
      readOptionalPriorFigures(input, priorWindow),
    ]
  );
  const locPerDollarBasis = resolveLocPerDollarCostBasis(costSplit);
  const { metrics: deliveryMetrics, priorMergedPrCount } =
    foldDeliverySummaryMetricsWithPrior(
      deliveryScope,
      priorWindow,
      locPerDollarBasis.costUsd
    );
  // ISS-11117: read AFTER the aggregate fan-out above, never inside it — the
  // delivery read opens its own outermost `RepeatableRead` transaction, and the
  // route hands over a reader only inside the server display half's rollout
  // (ISS-11895). The branch population is the set the attribution lens keys,
  // read above either with the published lens or on its own (ISS-12284).
  const penseroPointsPerDollar = readPenseroPointsPerDollar
    ? await readPenseroPointsPerDollar(
        attribution.branchArtifactIds,
        locPerDollarBasis.costUsd
      )
    : null;
  // ISS-7705: the verdict on whether that divisor covers the numerator it was
  // divided into. Omitted entirely when the scope found no merged PRs — see
  // `DeliveryPrScope.coverageCounts` for why absent is not `complete`.
  const locPerDollarCoverage = deliveryScope.coverageProbed
    ? foldLocPerDollarCoverage(deliveryScope.coverageCounts, {
        denominatorSessionCount: aggregate._count._all,
        costBasisCoveredUsd: locPerDollarBasis.costUsd,
        costBasisExcludedUsd: locPerDollarBasis.excludedUsd,
      })
    : undefined;
  if (locPerDollarCoverage) {
    emitTelemetryMetric({
      metric: SESSIONS_LOC_PER_DOLLAR_COVERAGE_METRIC,
      organizationId: input.organizationId,
      viewerScope: toViewerScope(input.filters),
      coverageState: locPerDollarCoverage.state,
      costBasis: locPerDollarBasis.basis,
      numeratorSessionCount: locPerDollarCoverage.numeratorSessionCount,
      denominatorSessionCount: locPerDollarCoverage.denominatorSessionCount,
      excludedSessionCount: locPerDollarCoverage.excludedSessionCount,
      costBasisCoveredUsd: locPerDollarCoverage.costBasisCoveredUsd,
      costBasisExcludedUsd: locPerDollarCoverage.costBasisExcludedUsd,
    });
  }

  // ISS-7422: pure arithmetic over two periods already in hand — the prior read
  // itself settled above, concurrently. `priorFigures` is undefined only when
  // that read FAILED, which degrades to the same absence a range with no prior
  // window produces.
  const comparison =
    priorWindow && priorFigures
      ? foldUsageComparison({
          current: {
            totalSessions: aggregate._count._all,
            // ISS-7175: all four counters, matching what the Sessions strip's
            // "Total Tokens" tile renders. This is the CURRENT-period side of
            // the token delta; `usage-comparison.ts` reads the prior period
            // through the SAME term list, so the chip cannot grade a movement
            // between two different quantities.
            totalTokens: sumSessionTokenCounters({
              input: toNumber(aggregate._sum.inputTokens),
              output: toNumber(aggregate._sum.outputTokens),
              cacheRead: toNumber(aggregate._sum.cacheReadTokens),
              cacheWrite: toNumber(aggregate._sum.cacheWriteTokens),
            }),
            meteredEstimatedCost: costSplit.meteredEstimatedCost,
            apiEstimatedCost: costSplit.apiEstimatedCost,
            // ISS-4748: read from the split, never re-summed here. That field
            // owns this total (it is what `...costSplit` publishes as the
            // headline below), so the delta's current side and the headline it
            // grades are literally the same number rather than two expressions
            // that agree until one of them is edited.
            totalEstimatedCost: costSplit.totalEstimatedCost,
            mergedPrCount: deliveryMetrics.mergedPrCount,
          },
          prior: priorFigures,
          priorMergedPrCount,
          priorWindow,
        })
      : undefined;

  // Facet payload shaping lives in `usage-facet-projections.ts` — this method
  // owns WHICH population each aggregate runs over (see `facet-count-where.ts`),
  // not how a raw group row becomes a facet option.
  const byUser = buildUsageByUser(byUserGroup, usersById);
  const byModel = buildUsageByModel(byModelGroup);
  // FEA-4303: Model filter facet options, keyed by the PRIMARY displayed
  // model so the facet, the predicate, and the table's Model column share one
  // vocabulary. See buildModelFilterOptions for the null-drop/sort rationale.
  const modelFilterOptions = buildModelFilterOptions(primaryModelGroup);
  const byHarness = buildUsageByHarness(byHarnessGroup);
  const byRepository = buildUsageByRepository(byRepositoryGroup);
  const summary: AgentSessionUsageSummary = {
    viewerScope: toViewerScope(input.filters),
    totalSessions: aggregate._count._all,
    earliestSessionAt: aggregate._min?.sessionStartedAt?.toISOString() ?? null,
    latestSessionAt: aggregate._max?.sessionStartedAt?.toISOString() ?? null,
    totalInputTokens: toNumber(aggregate._sum.inputTokens),
    totalOutputTokens: toNumber(aggregate._sum.outputTokens),
    totalCacheReadTokens: toNumber(aggregate._sum.cacheReadTokens),
    totalCacheWriteTokens: toNumber(aggregate._sum.cacheWriteTokens),
    // FEA-3986: the grand total is derived FROM the classified buckets (it is
    // `SessionCostSplit.totalEstimatedCost`, summed there over all three
    // ledgers), so `totalEstimatedCost === subscriptionEstimatedCost +
    // apiEstimatedCost` holds BY CONSTRUCTION over ONE `costsByLedger` snapshot.
    // Reading the total from the separate `aggregate` query instead let a
    // non-transactional drift between the two reads publish a headline that
    // disagreed with the breakdown (the divergence davetho/whitlockk flagged).
    ...costSplit,
    // FEA-3156 / ISS-4667: delivery-summary metrics (incl. the LOC/$ card and
    // its deprecated KLOC/$ alias) for the Sessions page top row.
    // ISS-9848: the SAME basis object the divisor above came from, so the
    // published `mergedLocPerDollarBasis` cannot describe a divisor this
    // response did not use.
    ...toDeliverySummaryFields(deliveryMetrics, locPerDollarBasis),
    // ISS-11117: the SAME denominator the line above divided, over the branches
    // these sessions touched. Omitted, never null, when there is no numerator —
    // that absence is what keeps the LOC/$ card rendering unchanged.
    ...(penseroPointsPerDollar === null ? {} : { penseroPointsPerDollar }),
    // ISS-7705: omitted, never null, when the scope had no ratio to gate — an
    // absent optional cross-repo field must not serialize as null.
    ...(locPerDollarCoverage
      ? { mergedLocPerDollarCoverage: locPerDollarCoverage }
      : {}),
    byUser,
    ...(attribution.lenses.byBranch.length > 0
      ? { byBranch: attribution.lenses.byBranch }
      : {}),
    ...(attribution.lenses.byPr.length > 0
      ? { byPr: attribution.lenses.byPr }
      : {}),
    byModel,
    modelFilterOptions,
    byHarness,
    byRepository,
    byProject,
    lastSyncTargets: lastSyncTargets.map(toLastSyncTarget),
    // Omitted, never null, when no comparison was requested or the range has no
    // prior window — an absent optional field is not serialized as null.
    ...(comparison ? { comparison } : {}),
  };

  emitTelemetryMetric({
    metric: SESSIONS_DASHBOARD_QUERY_LATENCY_METRIC,
    organizationId: input.organizationId,
    viewerScope: toViewerScope(input.filters),
    value: Date.now() - startedAtMs,
  });

  return summary;
}

/**
 * The prior period's figures, or nothing — never a rejected summary.
 *
 * The comparison is an OPTIONAL field on an otherwise-complete payload, and its
 * absence already has a defined meaning the client renders ("No prior period").
 * Awaiting the prior read unguarded gave it veto power over a summary whose own
 * aggregates had already succeeded: one slow prior query and the reader loses
 * every headline card, not just the chips. That was a regression in blast radius,
 * not just a missing catch — before ISS-5809 the prior read was a SEPARATE client
 * request, so its failure could only ever blank the chips.
 *
 * So the failure degrades to "no comparison" and is reported on the monitored
 * server path instead of to the reader. It is deliberately logged rather than
 * swallowed: a prior read that fails while the current one succeeds means the
 * cohort resolution or the cost snapshot is broken for one window only, which is
 * a real defect worth alerting on even though the response stays useful.
 *
 * ISS-7422: the guard now also protects the CONCURRENT stage this read joined —
 * an unguarded rejection inside that `Promise.all` would take the headline cards
 * down with it, which is the same veto in a new place.
 */
async function readOptionalPriorFigures(
  input: SessionUsageInput,
  priorWindow: UsageComparisonWindow | null
): Promise<PriorUsageFigures | undefined> {
  if (!priorWindow) {
    return undefined;
  }
  try {
    return await readPriorUsageFigures({ input, priorWindow });
  } catch (error) {
    log.error("Sessions usage prior-period comparison failed", {
      organizationId: input.organizationId,
      priorStartDate: priorWindow.startDate,
      priorEndDate: priorWindow.endDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

const NO_ATTRIBUTION_LENSES: AttributionLenses = { byBranch: [], byPr: [] };

/**
 * ISS-12284: the attribution reads one request needs, and no more.
 *
 * Published lenses are hydrated once and their `byBranch` keys double as the
 * Pensero branch set. Withheld lenses are never hydrated: when a numerator
 * still needs the branch set, it is read on its own
 * ({@link readSessionAttributionBranchIds}); otherwise nothing is read.
 */
async function readUsageAttribution(input: {
  organizationId: string;
  where: Prisma.SessionDetailWhereInput;
  limiter: LimitFunction;
  publishLenses: boolean;
  needsBranchIds: boolean;
}): Promise<{
  lenses: AttributionLenses;
  branchArtifactIds: readonly string[];
}> {
  if (input.publishLenses) {
    const lenses = await aggregateSessionAttributionLenses(
      input.organizationId,
      input.where,
      input.limiter
    );
    return {
      lenses,
      branchArtifactIds: lenses.byBranch.map(
        (branch) => branch.branchArtifactId
      ),
    };
  }
  if (!input.needsBranchIds) {
    return { lenses: NO_ATTRIBUTION_LENSES, branchArtifactIds: [] };
  }
  return {
    lenses: NO_ATTRIBUTION_LENSES,
    branchArtifactIds: await readSessionAttributionBranchIds(
      input.organizationId,
      input.where,
      input.limiter
    ),
  };
}
