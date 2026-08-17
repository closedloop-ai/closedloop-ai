// ISS-5809 — the Sessions usage-summary composition root.
//
// Extracted from `service.ts` (grandfathered shrink-only) so the summary read —
// which owns WHICH population each aggregate runs over, and now also the
// prior-period comparison — lives beside the modules it composes rather than
// inside the session service god-object. Same extraction `delivery-metrics.ts`
// already made out of this method.

import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type { AgentSessionUsageComparison } from "@repo/api/src/types/agent-session-usage-comparison";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { emitTelemetryMetric } from "@repo/observability/telemetry/metrics";
import { aggregateSessionAttributionLenses } from "@/lib/agent-session-attribution";
import { toNumber } from "@/lib/prisma-number";
import {
  computeDeliverySummaryMetricsWithPrior,
  toDeliverySummaryFields,
} from "./delivery-metrics";
import { buildSessionFacetCountWheres } from "./facet-count-where";
import { buildLastSyncTargetsQuery } from "./last-sync-targets";
import { buildModelFilterOptions } from "./model-filter-options";
import { buildProjectFacetOptions } from "./project-facet-options";
import { toLastSyncTarget, toViewerScope } from "./project-resolution";
import type { SessionUsageInput } from "./records";
import {
  computeUsageComparison,
  resolvePriorUsageWindow,
} from "./usage-comparison";
import { splitSessionCost } from "./usage-cost-split";
import {
  buildUsageByHarness,
  buildUsageByModel,
  buildUsageByRepository,
  buildUsageByUser,
} from "./usage-facet-projections";
import { buildUsageOwnerMap } from "./usage-owner-lookup";
import { buildUsageSummaryWhereParts } from "./usage-summary-where";

export async function buildUsageSummary(
  input: SessionUsageInput
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
  // FEA-4293/4294 (thread wongk, table↔summary parity): a cost-bucket filter is
  // applied by the TABLE on the RECONCILED captured cost, not on the stored
  // `estimatedCost` rollup the `buildCostBucketWhere` DB predicate keys off. So
  // the summary must NOT restate that rollup predicate (it would drop a legacy
  // row stored at 0 whose priced events total, say, $0.42 — a row the table
  // shows under "≤ $1"). Instead resolve the SAME reconciled-matched id set the
  // table paints and scope every summary aggregate to it, so the cards and the
  // table agree by construction. Every OTHER facet stays in `where`.
  const { where, costMatchedIds } = await buildUsageSummaryWhereParts(input);
  // ISS-5283: the per-option FACET counts run under a `where` that applies
  // every OTHER active filter but excludes the facet's own dimension, so a
  // filtered facet still lists the options the user can widen to instead of
  // collapsing to the one already selected. The summary TOTALS below keep the
  // fully filtered `where` — they describe the current view. A dimension with
  // no active filter reuses `where` verbatim and issues no extra query, so an
  // unfiltered read is unchanged. See `facet-count-where.ts` for the full
  // rationale and the security scope this deliberately does not relax.
  const facetWheres = await buildSessionFacetCountWheres(
    input,
    where,
    undefined,
    costMatchedIds
  );
  const [summaryRows, attributionLenses, byProject] = await Promise.all([
    withDb(async (db) =>
      Promise.all([
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
        }),
        db.sessionDetail.groupBy({
          by: ["userId"],
          // ISS-5283: Owner facet counts exclude the Owner selection itself.
          where: facetWheres.owner,
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
        }),
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
        }),
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
        }),
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
        }),
        // Cost split. Aggregate estimatedCost in the DB grouped by both
        // sourceLoopId and billingMode, instead of materializing one row per
        // session and summing in JS. Loop-originated rows are classified by the
        // linked loop's apiKeySource; DESKTOP_SYNC rows (no source Loop) are
        // classified by their synced billingMode. Classification below.
        db.sessionDetail.groupBy({
          by: ["sourceLoopId", "billingMode"],
          where,
          _sum: {
            estimatedCost: true,
          },
        }),
        // FEA-4303: Model filter facet options, grouped by the PRIMARY
        // displayed model (`SessionDetail.model`) — the exact string the
        // Sessions table paints in its Model column and the same field the
        // Model filter predicate matches. Sourced separately from `byModel`
        // (which spans every model a session used, including subagent models)
        // so the facet's options never offer a value the column can't show.
        db.sessionDetail.groupBy({
          by: ["model"],
          // ISS-5283: Model facet counts exclude the Model selection itself.
          where: facetWheres.model,
          _count: {
            _all: true,
          },
        }),
        // ISS-4828: the "Compute Target Freshness" card's population — page
        // width, select, and the presence-leads ordering live in the module.
        db.computeTarget.findMany(buildLastSyncTargetsQuery(input)),
      ])
    ),
    aggregateSessionAttributionLenses(where),
    buildProjectFacetOptions(input.organizationId, facetWheres.project),
  ]);
  const [
    aggregate,
    byUserGroup,
    byModelGroup,
    byHarnessGroup,
    byRepositoryGroup,
    costsByLoop,
    primaryModelGroup,
    lastSyncTargets,
  ] = summaryRows;
  // FEA-3986 / ISS-4773: the three-way cost split (subscription / confirmed
  // metered / unclassified) for the headline cards, classified from the
  // `costsByLoop` snapshot read above (one round-trip). Spread whole below so
  // the emitted fields cannot drift from the classifier. ISS-6398: its
  // `apiEstimatedCost` is also THE delivery LOC/$ denominator (passed below), so
  // the ratio and the Cost card divide/report one number, not two reads of it.
  const costSplit = await splitSessionCost(input.organizationId, costsByLoop);

  // FEA-3156 / FEA-4295 / ISS-4667: the delivery-summary metrics (PRs shipped,
  // median PR size, merged LOC/$), via the delivery-KPI SSOT engine. The
  // delivery scope and the `mergedAt` merge-window bounding live behind this
  // call — see its module doc.
  // ISS-6398: the LOC/$ DENOMINATOR is the `costSplit` computed above, i.e. the
  // API-billed spend of the session-activity-WINDOWED `where` (metered + unknown;
  // the Cost card headlines only the metered half under the ISS-4773 honesty
  // flag). Passing it here (rather than letting the delivery
  // module re-derive one over its date-window-stripped scope) is what makes the
  // ratio's two sides describe the same window, and it costs no extra query.
  // ISS-5809: the prior comparison window, resolved from the CURRENT window's
  // bounds rather than from a client-named range, so the equal-width guarantee
  // survives the current window changing shape. Null unless the caller opted in
  // and the active range actually has a period before it.
  const priorWindow =
    input.filters.comparison === AgentSessionComparisonMode.Prior
      ? resolvePriorUsageWindow(input.filters.startDate, input.filters.endDate)
      : null;
  const { metrics: deliveryMetrics, priorMergedPrCount } =
    await computeDeliverySummaryMetricsWithPrior(
      input,
      priorWindow,
      costSplit.apiEstimatedCost
    );

  // ISS-5809: the prior period's comparable figures — three queries, not the
  // ~13 a second full usage read cost. The prior merged-PR count above is
  // already free: the delivery scope is date-window-stripped and therefore
  // identical for both periods.
  const comparison = priorWindow
    ? await readOptionalComparison({
        input,
        priorWindow,
        current: {
          totalSessions: aggregate._count._all,
          totalTokens:
            toNumber(aggregate._sum.inputTokens) +
            toNumber(aggregate._sum.outputTokens),
          meteredEstimatedCost: costSplit.meteredEstimatedCost,
          apiEstimatedCost: costSplit.apiEstimatedCost,
          mergedPrCount: deliveryMetrics.mergedPrCount,
        },
        priorMergedPrCount,
      })
    : undefined;

  const usersById = await buildUsageOwnerMap(input.organizationId, byUserGroup);

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
    // FEA-3986: derive the grand total FROM the classified buckets so
    // `totalEstimatedCost === subscriptionEstimatedCost + apiEstimatedCost`
    // holds BY CONSTRUCTION. Both split fields come from the single
    // `costsByLoop` groupBy snapshot above (every matched row lands in exactly
    // one bucket), so their sum equals the grand total for that same snapshot.
    // Reading the total from the separate `aggregate` query instead let a
    // non-transactional drift between the two reads publish a headline that
    // disagreed with the breakdown (the divergence shafty023/wongk flagged).
    ...costSplit,
    totalEstimatedCost:
      costSplit.subscriptionEstimatedCost + costSplit.apiEstimatedCost,
    // FEA-3156 / ISS-4667: delivery-summary metrics (incl. the LOC/$ card and
    // its deprecated KLOC/$ alias) for the Sessions page top row.
    ...toDeliverySummaryFields(deliveryMetrics),
    byUser,
    ...(attributionLenses.byBranch.length > 0
      ? { byBranch: attributionLenses.byBranch }
      : {}),
    ...(attributionLenses.byPr.length > 0
      ? { byPr: attributionLenses.byPr }
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
    metric: "agent_sessions.dashboard.query_latency",
    organizationId: input.organizationId,
    viewerScope: toViewerScope(input.filters),
    value: Date.now() - startedAtMs,
  });

  return summary;
}

/**
 * The comparison, or nothing — never a rejected summary.
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
 */
async function readOptionalComparison(
  args: Parameters<typeof computeUsageComparison>[0]
): Promise<AgentSessionUsageComparison | undefined> {
  try {
    return await computeUsageComparison(args);
  } catch (error) {
    log.error("Sessions usage prior-period comparison failed", {
      organizationId: args.input.organizationId,
      priorStartDate: args.priorWindow.startDate,
      priorEndDate: args.priorWindow.endDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
